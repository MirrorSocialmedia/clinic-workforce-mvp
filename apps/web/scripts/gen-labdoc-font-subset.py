#!/usr/bin/env python3
"""
gen-labdoc-font-subset.py — 生成 test/fixtures/labdoc/noto-sans-cjk-tc.subset.ttf
（cwm-labdoc P1 CHUNK5，2026-10-05；one-off provenance script，唔係 build 依賴）

目的
----
sample-text.pdf 要嵌入 subset 字體（FontFile2 TrueType），alpine（零 font 包）都渲染得到。
字體來源：Noto Sans CJK TC（本機 /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc，
SIL OFL 1.1；face 按 name 搵，唔硬編 index）。

點解唔係 DroidSansFallbackFull（原施工單指定）：
  本機 2016-02-13 build 嘅 DroidSansFallbackFull.ttf cmap 全檔只有 U+0000 + U+0020(space)
  兩個 <0x200 映射（純 CJK fallback 設計，無 Latin glyph）→ 無法 subset 出 fixture 用嘅
  英文 glyph。Noto Sans CJK 同時有完整 Latin + CJK，同 runner stage 嘅 font-noto-cjk
  同家族，一套字體覆低 fixture（Latin）同生產（中文單據）兩個場景。

做法
----
1. pyftsubset：subset 到 --text-file 指定嘅字符集（drop layout/hinting 表）。
2. CFF→TrueType 轉換（Cu2QuPen）：Noto CJK 係 CFF 字體，FontFile2 要求 glyf；
   轉完删 CFF，maxp 升 1.0，補 loca。
3. 自驗：重開檔，全部字符 cmap 可解析到、cmap 有 (3,1) format 4 subtable、
   表集合 == pdf.js VALID_TABLES（多餘表會令 audit 難讀；pdf.js 本身係跳過唔報錯）。

可重現性
--------
- 本 script + 源字體版本 + 字符集 → 輸出 byte-deterministic（fonttools 4.62.1 實測）。
- 輸出（subset ttf）已 commit 入 repo；CI 唔需要 fonttools，都唔需要源字體。
- 重新生成：
    python3 apps/web/scripts/gen-labdoc-font-subset.py \
      --text-file <charset.txt> \
      --out apps/web/test/fixtures/labdoc/noto-sans-cjk-tc.subset.ttf
  charset.txt = gen-labdoc-fixtures.mjs 兩頁文字嘅 unique 字符（sort by code）；
  字體有改 / 字符集有改先要重跑。重跑後要重新生成 sample-text.pdf 並重走
  pdfinfo/pdftotext/render-check 驗證。

Run 需要：python3 + fonttools（4.62.x 實測）、NotoSansCJK-Regular.ttc 喺系統路徑。
"""
import argparse
import os
import sys

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTCollection, TTFont, newTable
from fontTools.ttLib.tables._g_l_y_f import table__g_l_y_f

DEFAULT_TTC = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
FACE_NAME = "Noto Sans CJK TC"
MAX_ERR = 1.0  # cu2qu 最大誤差（upm=1000 單位）；Noto Latin 字形簡單，1.0 視覺無差
# pdf.js checkAndRepair 識收嘅表（pdf.worker.mjs VALID_TABLES）
EXPECTED_TABLES = {"OS/2", "cmap", "head", "hhea", "hmtx", "maxp", "name", "post", "loca", "glyf"}


def pick_face(ttc_path, face_name):
    col = TTCollection(ttc_path)
    for i, f in enumerate(col.fonts):
        if f["name"].getDebugName(1) == face_name:
            return f
    raise SystemExit(f"face {face_name!r} 搵唔到；有：{[f['name'].getDebugName(1) for f in col.fonts]}")


def subset_font(font, text):
    opt = Options()
    opt.layout_features = []  # drop GSUB/GPOS（PDF 嵌入唔使 layout）
    opt.hinting = False       # drop fpgm/prep/cvt + glyf instructions
    opt.autohint = False
    opt.notdef_outline = True
    opt.retain_gids = False
    opt.desubroutinize = True
    opt.drop_tables = list(opt.drop_tables) + ["GDEF", "GSUB", "GPOS", "gasp", "vhea", "vmtx", "BASE", "VORG"]
    sub = Subsetter(options=opt)
    sub.populate(text=text)
    sub.subset(font)


def cff_to_true_type(font):
    """CFF charstring → quadratic glyf（Cu2QuPen）；Noto CJK 全係 simple outline，無 composite。"""
    from fontTools.pens.cu2quPen import Cu2QuPen
    from fontTools.pens.ttGlyphPen import TTGlyphPen

    assert "CFF " in font, "expected CFF font"
    glyphOrder = font.getGlyphOrder()
    charStrings = font["CFF "].cff.topDictIndex[0].CharStrings

    glyf = table__g_l_y_f()
    glyf.glyphOrder = glyphOrder
    glyf.glyphs = {}
    for name in glyphOrder:
        ttPen = TTGlyphPen(None)
        cu2quPen = Cu2QuPen(ttPen, MAX_ERR, reverse_direction=True)
        try:
            charStrings[name].draw(cu2quPen)
            glyph = ttPen.glyph()
        except Exception:
            # 轉唔到（應該唔會發生）→ 留空 glyph，唔好靜默出錯
            raise
        glyf.glyphs[name] = glyph

    font["glyf"] = glyf
    font["loca"] = newTable("loca")
    maxp = font["maxp"]
    maxp.version = 0x00010000  # glyf 要 maxp 1.0（CFF 只係 0.5）
    maxp.maxZones = 1
    maxp.maxTwilightPoints = 0
    maxp.maxStorage = 0
    maxp.maxFunctionDefs = 0
    maxp.maxInstructionDefs = 0
    maxp.maxStackElements = 0
    maxp.maxSizeOfInstructions = 0
    maxp.maxComponentElements = 0
    del font["CFF "]
    font.recalcBBoxes = True
    # sfntVersion 唔會自動重算（load 時係 OTTO）— 必須手動轉回 TrueType
    font.sfntVersion = "\x00\x01\x00\x00"


def verify(font, text, out_path):
    missing = sorted(ch for ch in set(text) if ord(ch) not in font.getBestCmap())
    if missing:
        raise SystemExit("cmap 缺字符: " + "".join(missing))
    subtables = [(t.platformID, t.platEncID, t.format) for t in font["cmap"].tables]
    if (3, 1, 4) not in subtables:
        raise SystemExit(f"cmap 無 (3,1) format 4 subtable：{subtables}")
    tables = set(font.keys()) - {"GlyphOrder"}  # GlyphOrder 係 fontTools 虛位，唔係真表
    extra = tables - EXPECTED_TABLES
    if extra:
        print(f"  warn: 多餘表（pdf.js 會跳過）: {sorted(extra)}")
    # glyf 可編譯自驗（compile 會重算 maxp 計數）
    font["glyf"].compile(font)
    size = os.path.getsize(out_path)
    cmap = font.getBestCmap()
    print(
        f"subset OK: {len(font.getGlyphOrder())} glyphs, cmap {len(cmap)} entries, "
        f"upm {font['head'].unitsPerEm}, "
        f"ascent {font['hhea'].ascent}, descent {font['hhea'].descent}, "
        f"capHeight {font['OS/2'].sCapHeight}, bbox "
        f"[{font['head'].xMin} {font['head'].yMin} {font['head'].xMax} {font['head'].yMax}], "
        f"post fmt {font['post'].formatType}, {size} bytes"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ttc", default=DEFAULT_TTC)
    ap.add_argument("--face", default=FACE_NAME)
    ap.add_argument("--text-file", required=True, help="字符集檔案（無重複、無換行）")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    with open(args.text_file, encoding="utf-8") as fh:
        # 字符集可能以 space 開頭 — 唔好 strip()（會吃掉 space），只去尾換行
        text = fh.read().rstrip("\n")

    font = pick_face(args.ttc, args.face)
    subset_font(font, text)
    cff_to_true_type(font)
    font.save(args.out)

    recheck = TTFont(args.out)
    verify(recheck, text, args.out)


if __name__ == "__main__":
    sys.exit(main())
