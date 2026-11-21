#!/usr/bin/env python3
"""KataGo の .bin.gz モデル(モデルバージョン 8〜10, ReLU, g170 世代)を ONNX に変換する。

使い方:
  pip install onnx numpy
  python3 tools/katago2onnx.py g170e-b10c128-s1141046784-d204142634.bin.gz public/models/b10c128.onnx

入力:
  bin    float32 [1, 22, H, W]  KataGo V7 の盤面特徴 (NCHW)。チャンネル0は盤上マスク(全部1)
  global float32 [1, 19]        KataGo V7 の大域特徴
出力:
  policy    [1, H*W+1]  着手のロジット(最後がパス)
  value     [1, 3]      勝ち/負け/無勝負 のロジット(手番側から見た値)
  score     [1, N]      スコア系(先頭が予想目差)
  ownership [1, H*W]    手番側から見た所有(tanh 済み, -1〜1)

盤の大きさは H, W を動的にしてあるので、9路でも13路でも同じファイルで動く。
変換の中身は KataGo の cpp/neuralnet/desc.cpp と eigenbackend.cpp の読み込み・推論をそのまま写したもの。
"""
import gzip
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


class Reader:
    def __init__(self, data: bytes):
        self.d = data
        self.i = 0

    def tok(self) -> str:
        d, i = self.d, self.i
        while d[i] in b" \t\r\n":
            i += 1
        j = i
        while d[j] not in b" \t\r\n":
            j += 1
        self.i = j
        return d[i:j].decode()

    def int(self) -> int:
        return int(self.tok())

    def float(self) -> float:
        return float(self.tok())

    def floats(self, n: int) -> np.ndarray:
        at = self.d.index(b"@BIN@", self.i)
        assert at - self.i < 100, "binary block header not found"
        start = at + 5
        arr = np.frombuffer(self.d, dtype="<f4", count=n, offset=start).astype(np.float32)
        self.i = start + 4 * n
        return arr


def read_conv(r):
    name = r.tok()
    ky, kx, ic, oc, dy, dx = (r.int() for _ in range(6))
    assert dy == 1 and dx == 1
    w = r.floats(ky * kx * ic * oc).reshape(ky, kx, ic, oc).transpose(3, 2, 0, 1)  # -> oc, ic, y, x
    return dict(name=name, w=np.ascontiguousarray(w), k=ky)


def read_bn(r):
    name = r.tok()
    c = r.int()
    eps = r.float()
    has_scale = r.int()
    has_bias = r.int()
    mean = r.floats(c)
    var = r.floats(c)
    scale = r.floats(c) if has_scale else np.ones(c, np.float32)
    bias = r.floats(c) if has_bias else np.zeros(c, np.float32)
    ms = scale / np.sqrt(var + eps)
    mb = bias - ms * mean
    return dict(name=name, scale=ms.astype(np.float32), bias=mb.astype(np.float32))


def read_act(r, version):
    name = r.tok()
    if version >= 11:
        kind = r.tok()
        assert kind == "ACTIVATION_RELU", kind
    return name


def read_matmul(r):
    name = r.tok()
    ic, oc = r.int(), r.int()
    return dict(name=name, w=r.floats(ic * oc).reshape(ic, oc))


def read_matbias(r):
    name = r.tok()
    c = r.int()
    return dict(name=name, b=r.floats(c))


def read_model(path):
    r = Reader(gzip.open(path, "rb").read())
    m = {}
    m["name"] = r.tok()
    m["version"] = v = r.int()
    assert 8 <= v <= 10, f"model version {v} is not supported by this converter"
    m["nin"] = r.int()
    m["nglobal"] = r.int()
    # trunk
    r.tok()  # trunk name
    nblocks = r.int()
    trunk_c, mid_c, reg_c, _dil_c, gpool_c = (r.int() for _ in range(5))
    m["trunk_c"] = trunk_c
    m["conv1"] = read_conv(r)
    m["ginput"] = read_matmul(r)
    blocks = []
    for _ in range(nblocks):
        kind = r.tok()
        b = dict(kind=kind, name=r.tok())
        b["preBN"] = read_bn(r)
        read_act(r, v)
        b["conv1"] = read_conv(r)
        if kind == "gpool_block":
            b["gconv"] = read_conv(r)
            b["gBN"] = read_bn(r)
            read_act(r, v)
            b["gmul"] = read_matmul(r)
        else:
            assert kind == "ordinary_block", kind
        b["midBN"] = read_bn(r)
        read_act(r, v)
        b["conv2"] = read_conv(r)
        blocks.append(b)
    m["blocks"] = blocks
    m["tipBN"] = read_bn(r)
    read_act(r, v)
    # policy head
    r.tok()
    p = {}
    p["p1"] = read_conv(r)
    p["g1"] = read_conv(r)
    p["g1BN"] = read_bn(r)
    read_act(r, v)
    p["gbias"] = read_matmul(r)
    p["p1BN"] = read_bn(r)
    read_act(r, v)
    p["p2"] = read_conv(r)
    p["gpass"] = read_matmul(r)
    m["policy"] = p
    # value head
    r.tok()
    q = {}
    q["v1"] = read_conv(r)
    q["v1BN"] = read_bn(r)
    read_act(r, v)
    q["v2"] = read_matmul(r)
    q["v2b"] = read_matbias(r)
    read_act(r, v)
    q["v3"] = read_matmul(r)
    q["v3b"] = read_matbias(r)
    q["sv3"] = read_matmul(r)
    q["sv3b"] = read_matbias(r)
    q["own"] = read_conv(r)
    m["value"] = q
    return m


class G:
    """ONNX グラフを組み立てる小さなヘルパー"""

    def __init__(self):
        self.nodes = []
        self.inits = []
        self.n = 0

    def name(self, base):
        self.n += 1
        return f"{base}_{self.n}"

    def const(self, arr, base="c"):
        nm = self.name(base)
        self.inits.append(numpy_helper.from_array(np.asarray(arr), nm))
        return nm

    def op(self, op_type, inputs, base=None, **attrs):
        out = self.name(base or op_type.lower())
        self.nodes.append(helper.make_node(op_type, inputs, [out], **attrs))
        return out

    def conv(self, x, c):
        pad = c["k"] // 2
        return self.op("Conv", [x, self.const(c["w"], c["name"])], kernel_shape=[c["k"], c["k"]], pads=[pad] * 4)

    def bn_relu(self, x, bn):
        c = len(bn["scale"])
        s = self.const(bn["scale"].reshape(1, c, 1, 1), bn["name"] + "_s")
        b = self.const(bn["bias"].reshape(1, c, 1, 1), bn["name"] + "_b")
        return self.op("Relu", [self.op("Add", [self.op("Mul", [x, s]), b])])

    def matmul(self, x, mm):
        return self.op("MatMul", [x, self.const(mm["w"], mm["name"])])


def build(m):
    g = G()
    x_in, g_in = "bin", "global"
    # 盤上の点数 = マスク(チャンネル0)の合計。そこから KataGo の gpool 用の係数を作る
    mask = g.op("Slice", [x_in, g.const(np.array([0], np.int64)), g.const(np.array([1], np.int64)), g.const(np.array([1], np.int64))])
    area = g.op("ReduceSum", [mask, g.const(np.array([1, 2, 3], np.int64))], keepdims=0)  # [1]
    sq = g.op("Sqrt", [area])
    b14 = g.op("Mul", [g.op("Sub", [sq, g.const(np.array(14, np.float32))]), g.const(np.array(0.1, np.float32))])
    b14 = g.op("Reshape", [b14, g.const(np.array([1, 1], np.int64))])  # [1,1]
    b14sq = g.op("Sub", [g.op("Mul", [b14, b14]), g.const(np.array(0.1, np.float32))])

    def gpool(x, value_head=False):
        mean = g.op("ReduceMean", [x], axes=[2, 3], keepdims=0)  # [1,C]
        a = g.op("Mul", [mean, b14])
        third = g.op("Mul", [mean, b14sq]) if value_head else g.op("ReduceMax", [x], axes=[2, 3], keepdims=0)
        return g.op("Concat", [mean, a, third], axis=1)

    def add_bias_nc(x, bias):  # bias [1,C] を [1,C,1,1] にして足す
        return g.op("Add", [x, g.op("Unsqueeze", [bias, g.const(np.array([2, 3], np.int64))])])

    t = g.conv(x_in, m["conv1"])
    t = add_bias_nc(t, g.matmul(g_in, m["ginput"]))
    for b in m["blocks"]:
        a = g.bn_relu(t, b["preBN"])
        r = g.conv(a, b["conv1"])
        if b["kind"] == "gpool_block":
            gg = g.bn_relu(g.conv(a, b["gconv"]), b["gBN"])
            r = add_bias_nc(r, g.matmul(gpool(gg), b["gmul"]))
        r = g.conv(g.bn_relu(r, b["midBN"]), b["conv2"])
        t = g.op("Add", [t, r])
    t = g.bn_relu(t, m["tipBN"])

    p = m["policy"]
    p1 = g.conv(t, p["p1"])
    g1 = g.bn_relu(g.conv(t, p["g1"]), p["g1BN"])
    g1c = gpool(g1)
    p1 = add_bias_nc(p1, g.matmul(g1c, p["gbias"]))
    p2 = g.conv(g.bn_relu(p1, p["p1BN"]), p["p2"])  # [1,1,H,W]
    p2 = g.op("Reshape", [p2, g.const(np.array([1, -1], np.int64))])
    ppass = g.matmul(g1c, p["gpass"])  # [1,1]
    g.nodes.append(helper.make_node("Concat", [p2, ppass], ["policy"], axis=1))

    q = m["value"]
    v1 = g.bn_relu(g.conv(t, q["v1"]), q["v1BN"])
    vp = gpool(v1, value_head=True)
    v2 = g.op("Relu", [g.op("Add", [g.matmul(vp, q["v2"]), g.const(q["v2b"]["b"])])])
    g.nodes.append(helper.make_node("Add", [g.matmul(v2, q["v3"]), g.const(q["v3b"]["b"])], ["value"]))
    g.nodes.append(helper.make_node("Add", [g.matmul(v2, q["sv3"]), g.const(q["sv3b"]["b"])], ["score"]))
    own = g.op("Tanh", [g.conv(v1, q["own"])])
    g.nodes.append(helper.make_node("Reshape", [own, g.const(np.array([1, -1], np.int64))], ["ownership"]))

    graph = helper.make_graph(
        g.nodes,
        m["name"],
        [
            helper.make_tensor_value_info("bin", TensorProto.FLOAT, [1, m["nin"], "H", "W"]),
            helper.make_tensor_value_info("global", TensorProto.FLOAT, [1, m["nglobal"]]),
        ],
        [
            helper.make_tensor_value_info("policy", TensorProto.FLOAT, [1, None]),
            helper.make_tensor_value_info("value", TensorProto.FLOAT, [1, 3]),
            helper.make_tensor_value_info("score", TensorProto.FLOAT, [1, None]),
            helper.make_tensor_value_info("ownership", TensorProto.FLOAT, [1, None]),
        ],
        g.inits,
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)], producer_name="katago2onnx")
    model.ir_version = 8
    onnx.checker.check_model(model)
    return model


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    m = read_model(src)
    print(f"{m['name']}: version {m['version']}, {len(m['blocks'])} blocks x {m['trunk_c']}ch")
    onnx.save(build(m), dst)
    print("wrote", dst)
