> 历史工程记录的开源脱敏副本。文中的部署结果属于原项目当时的验证记录，示例域名、账号、路径不能用于访问原部署；当前配置以仓库 README 和 docs/DEPLOYMENT.md 为准。

# 长翼久安闪传中心 — Design QA

## Sources

- visual reference: `<local-reference-image>`
- issue-state reference: `<local-reference-image>`
- desktop implementation: `design-implementation.png`
- production implementation: `design-production.png`
- mobile implementation: `design-mobile.png`
- long-filename mobile state: `design-long-filename-mobile.png`
- combined comparison: `design-comparison.png`
- focused comparison: `design-comparison-focus.png`

## Test state

- desktop viewport: 1749 × 948 CSS px, matching the reference aspect and half-resolution dimensions
- mobile viewport: 390 × 844 CSS px
- production URL: `https://files.example.com/transfer/`
- product name: `长翼久安闪传中心`
- theme difference: the reference's dark palette was intentionally inverted to white by explicit user direction; composition, centering, restraint and control density were the matching targets

## Visual comparison

- Title and command bar use the same centered single-focus composition as the reference.
- The white canvas has no decorative illustration, marketing copy, card stack, gradient or shadow.
- Only upload, copy-code, pickup input, pickup action, recent files and refresh remain visible.
- Desktop command bar is 800 px maximum width and remains centered without horizontal overflow.
- Mobile controls wrap into three compact rows at 390 px with no horizontal overflow.
- A URL-like uninterrupted filename is clamped to two wrapped lines at 390 px; document and body scroll widths both remain 390 px.
- Recent files are separated by hairlines rather than card containers.
- Product name was corrected from `长意久安` to `长翼久安` in UI, metadata, planning and design-system documents.

## Functional states

- Upload progress shows uploaded/total bytes, live MB/s, percentage, concurrency and part size.
- The progress area remains visible while OSS object validation runs, then automatically hides only after the completion API succeeds.
- Successful completion keeps only the file name, pickup code, copy link and expiry countdown.
- Desktop Chrome/Edge download uses up to 12 parallel HTTP Range requests and direct positional disk writes; unsupported browsers fall back to the standard signed URL.
- The main page loaded locally and in production with no console warnings or errors.
- A 512 MiB production browser upload completed, generated a pickup code, appeared in recent files, and auto-hid the upload progress area.

## Checks

- `npm run check`: passed
- desktop horizontal overflow: none
- mobile horizontal overflow: none
- production title and DOM labels: passed
- production service health: passed
- reference plus implementation reviewed together at full-view and focused crops: passed

final result: passed
