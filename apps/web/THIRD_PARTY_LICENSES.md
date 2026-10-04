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
