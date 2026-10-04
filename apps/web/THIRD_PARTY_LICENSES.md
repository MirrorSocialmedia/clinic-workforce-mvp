# Third-Party Licenses

## TailAdmin (UI components reference)
Source: https://github.com/TailAdmin/free-nextjs-admin-dashboard
Licensed under the MIT License.
Copyright (c) 2023 TailAdmin

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

> Note: TailAdmin is used as a reference only. No code is directly copied. The sidebar layout was inspired by TailAdmin's design patterns and rewritten from scratch with Tailwind CSS classes.

## sharp (image processing — labdoc 顯示圖/縮圖 pipeline)
Source: https://github.com/lovell/sharp
Licensed under the Apache License, Version 2.0 (Apache-2.0).
Copyright (c) Lovell Fuller and contributors.
Full license text: https://www.apache.org/licenses/LICENSE-2.0

> Note: 施工單 cwm-labdoc §4.2 新依賴（P1）。用於 PDF/相片上傳後生成顯示圖（長邊 1600）＋縮圖（長邊 320）、按 EXIF orientation 轉正。

## pdfjs-dist (PDF text extraction + rendering — labdoc 讀單/檔案庫)
Source: https://github.com/mozilla/pdf.js (npm: `pdfjs-dist`)
Licensed under the Apache License, Version 2.0 (Apache-2.0).
Copyright (c) Mozilla Foundation.
Full license text: https://www.apache.org/licenses/LICENSE-2.0

> Note: 施工單 cwm-labdoc §4.2 新依賴（P1）。用於上傳 PDF 逐頁抽文字（hasTextLayer = 每頁 ≥20 字）＋檔案庫檢視器渲染頁圖。

## @napi-rs/canvas (canvas rendering — pdfjs node 渲染後端)
Source: https://github.com/Brooooooklyn/canvas (npm: `@napi-rs/canvas`)
Licensed under the MIT License.
Copyright (c) 2024 Brooklyn (canvas contributors).
Full license text: https://github.com/Brooooooklyn/canvas/blob/main/LICENSE

> Note: 施工單 cwm-labdoc §4.2 新依賴（P1）。pdfjs-dist 喺 node（alpine/musl）環境渲染所需嘅 canvas 實現（canvasFactory）。

## Noto Sans CJK（test fixture 嵌入字體 — labdoc sample-text.pdf）
Source: https://github.com/notofonts/noto-cjk （本機 `NotoSansCJK-Regular.ttc` face "Noto Sans CJK TC"）
Licensed under the SIL Open Font License, Version 1.1 (OFL-1.1).
Copyright (c) 2012-2024 The Noto Project authors.
Full license text: https://openfontlicense.org (https://github.com/notofonts/noto-cjk/blob/main/LICENSE.OFL)

> Note: **唔係 app 依賴** — 只係 `test/fixtures/labdoc/sample-text.pdf` 內嵌入嘅 subset
> （`test/fixtures/labdoc/noto-sans-cjk-tc.subset.ttf`，59 glyphs / 6KB，FontFile2）。
> 用途：令 fixture 文字層喺 node:22-alpine（零系統 font）都可渲染/提取（P1 CHUNK5 alpine 渲染 RED 根治）。
> 生成：`scripts/gen-labdoc-font-subset.py`（fonttools subset + CFF→TrueType 轉換，可重現）；
> 重生成指令喺 `scripts/gen-labdoc-fixtures.mjs` 頭部註記。
> 點解唔係原施工單指定嘅 Droid Sans Fallback：本機 2016-02-13 build 嘅
> `DroidSansFallbackFull.ttf` cmap 無 Latin glyph（純 CJK fallback 設計）→  subset 唔到
> fixture 英文字符；Noto Sans CJK 同時有完整 Latin + CJK，同 runner stage 嘅
> `font-noto-cjk` 系統字型同家族。

```
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
may be redistributed as long as it meets the requirements of this license.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
