# Spelltype 许可

Spelltype 自有代码及其他自有材料采用 **Apache License 2.0 + Commons Clause 1.0**。完整条款见 [LICENSE](LICENSE)，版权声明为 **Copyright (c) 2026 JGBingZi**，见 [COPYRIGHT](COPYRIGHT)。两部分共同构成许可，不可只取 Apache 2.0 而忽略 Commons Clause。

## 使用范围

- 允许在遵守许可证的前提下查看、使用、修改和分发源码。
- Commons Clause 禁止未经另行授权进行其定义的 **Sell**：向第三方收取费用或其他对价，提供价值全部或实质上来自本软件功能的产品或服务；定义包括相关收费托管、咨询或支持服务。
- **这不是全面禁止商业使用。** 企业内部使用，以及不构成上述 Sell 的商业用途，不因具有商业性质就自动被禁止。是否受限取决于条款定义，而不是简单地看是否收费或是否修改了代码。
- 项目权利人仍可自行商业使用自己拥有的作品或另行授权；这不免除第三方许可义务，也不自动取得其他贡献者的权利。涉及受限销售或其他另行授权，请联系项目维护者并取得相关权利人的许可。

此组合是 **source-available（源码公开）**许可，不是 OSI 定义的开源许可，也不是不附限制的 Apache-2.0。`package.json` 使用 `SEE LICENSE IN LICENSE`，避免将整个项目误标成纯 Apache-2.0。

## 第三方材料

Commons Clause 仅适用于项目权利人自己的可许可权利，**不覆盖**第三方材料：

- `.agents/skills/` 保持各自上游许可证；见 [Skills 许可索引](licenses/skills/INDEX.md)。
- npm 依赖保持各自上游许可证，沿用包内及上游声明，不逐包复制到本仓库；见[依赖许可说明](licenses/dependencies/INDEX.md)。
- `licenses/` 中的上游法律文本保留原样，不改以项目许可授权。
- 美术来源见 `public/assets/provenance.json`；项目许可仅适用于实际持有的可许可权利，不声称纯 AI 输出在所有司法辖区均享有独占版权。

完整第三方声明入口：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 分发

分发项目时，保留 Apache 2.0 与 Commons Clause 两部分、版权声明及相关第三方声明；修改第三方材料时遵守其原许可的修改标记等要求。浏览器构建、Bun 服务端产物等分发物也应随附所含组件要求的声明，根目录文档不会自动进入 Vite 的 `dist/`。

本页是说明，不修改英文许可正文。官方来源：[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt)、[Commons Clause 1.0](https://commonsclause.com/)。
