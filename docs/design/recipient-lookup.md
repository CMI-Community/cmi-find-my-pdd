# 收件人名与单号：面单线索卡

2026-10-07。与 `docs/PRODUCT.md` 的收件人名实施合同一起交付。现有大幅插画仍表达“找包裹／找失主”；新增场景、面单高亮、输入图标和局部颜色共同表达“快递单号／收件人名”。这两个维度可以独立切换。

## 原创素材与实现

使用内置 **imagegen** 工具生成两张透明背景原创插画，以现有 `home-detectives-lost-mobile.webp` 中的虚构侦探为画风、服装和人物参考。没有使用真实收件人、有效单号或社区成员照片。图中的卡片留白；前端绘制“收件人”、条码图标和高亮线，图片失败时仍有完整文字按钮及常驻输入图标。

- `src/assets/lookup-detective-waybill.webp`：600×400，39,692字节，透明WebP。
- `src/assets/lookup-detective-recipient.webp`：600×400，41,802字节，透明WebP。

PNG原稿保存在工具默认输出位置，使用 `cwebp -q 82 -alpha_q 100 -resize 600 0` 转码保留透明通道。网站只引用上述本地WebP。

单号状态使用紫色 `#674782`，侦探举放大镜检查条码卡；姓名状态使用深琥珀色 `#8A5124`，同一人物露出想起来的表情并指向姓名卡。面单位置分别适配生成素材。手机场景116×84px，桌面148×96px；固定场景区高度，支持减少动态效果。按钮保持完整文字及至少44px触控高度。

## 实际生成提示词

第一张以现有手机插画为参考：

> Use case: illustration-story. Asset: small production website illustration with a genuinely transparent background, horizontal 3:2 composition, full body completely visible. The attached image is STYLE AND CHARACTER REFERENCE only, do not edit or recreate the whole scene. Isolate the same fictional male community detective from its left side: tousled short black hair, expressive round face, purple T-shirt, beige shorts, orange flip-flops, warm hand-drawn shaded cartoon outlines, exact same illustration aesthetic. Create a new playful pose: crouching on the LEFT, holding a large magnifying glass and examining a blank cream shipping-label card held up on the RIGHT. Serious exaggerated detective concentration, one eyebrow raised; humorous and friendly. The character fills the left 65% and the card fills the right 35%, with the blank card front facing the viewer, clean large empty region for a website to overlay a barcode icon later. No text, no letters, no numbers, no barcode, no brands, no speech bubble, no extra people, no surrounding scene or ground plane. Maintain readable silhouette when displayed at 148 by 96 pixels. Preserve transparent alpha, not a white or checkerboard background.

第二张以第一张生成的PNG为参考：

> Use case: illustration-story. Asset: second paired production website illustration, genuinely transparent background, same horizontal 3:2 canvas. The reference is the first state of the same tiny detective illustration. Keep the same fictional young man, short tousled black hair, purple shirt, beige shorts, orange flip-flops and hand-drawn shaded cartoon style, same scale and crouching position on the LEFT. Keep a blank cream label card on the RIGHT, front-facing, occupying approximately x=65-97%, y=23-58% of the canvas, similar card size and location so HTML text can be overlaid. CHANGE the action and expression to friendly sudden recognition: bright smile, raised eyebrows, looking at the card with an 'I remember that person!' expression, one hand holds the blank card while the other index finger POINTS to its middle/lower line. The large magnifying glass is lowered and tucked at his side rather than covering his face or card. This is the recipient-name state: a warm subtly amber highlight in the blank card border, but preserve purple clothing and orange slippers. Card must be entirely empty, no letters, names, barcode, numbers, logos, speech bubble or other people. Full body visible, edge-safe silhouette, readable at 148x96. Background must contain only transparent alpha, no colored fog, no ambient glow or ground shadow extending beyond the subject.

素材的实际卡片位置稍有不同，前端已分别校准高亮层，而不是依赖图片内的文字来识别模式。姓名卡只展示字段示意，不展示虚构人名。
