# Gemini Theme

Gemini 的 VS Code 主题，深浅两套。

- **Gemini Dark**：界面用 [dsh-claude-style](../) 的 Gemini 深色：画布 `#191722`、面板 `#1d1a28`、侧栏与状态栏 `#201d2b`、强调 `#8b7bd8`；代码配色取自 [Gemini Theme](https://github.com/viniciusram2025/Gemini-Theme)（MIT，Vinicius de Paula）的 241 条语法规则与 3 条语义高亮。
- **Gemini Light**：配色取自插件的 Gemini 浅色种子：画布 `#fcfaff`、侧栏 `#f8f4ff`、强调 `#8b7bd8`、代码 `#7a3e93`。

## 安装

```bash
code --install-extension gemini-theme-0.1.4.vsix
```

然后在 `文件 > 首选项 > 颜色主题`（`Cmd+K Cmd+T`）里选 **Gemini Dark** 或 **Gemini Light**。

## 从源码打包

```bash
npx @vscode/vsce package
```

## 第三方

深色主题的代码配色（`tokenColors` 与 `semanticTokenColors`）改编自 Gemini Theme（CodeGemini），MIT 许可，原文见 [themes/LICENSE-gemini-theme.txt](themes/LICENSE-gemini-theme.txt)。

## License

MIT
