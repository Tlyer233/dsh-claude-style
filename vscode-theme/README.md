# Gemini Theme

Gemini 紫的 VS Code 主题，深浅两套，配色取自 [dsh-claude-style](../) 的 Gemini 品牌色：画布 `#191722`、侧栏 `#201d2b`、强调 `#8b7bd8`、代码 `#d9c5ff`。

## 安装

```bash
code --install-extension gemini-theme-0.1.0.vsix
```

然后在 `文件 > 首选项 > 颜色主题`（`Cmd+K Cmd+T`）里选 **Gemini Dark** 或 **Gemini Light**。

## 主题

| 名称 | 类型 | 画布 | 强调 |
|---|---|---|---|
| Gemini Dark | 深色 | `#191722` | `#8b7bd8` |
| Gemini Light | 浅色 | `#fcfaff` | `#8b7bd8` |

两套覆盖同一批键：编辑器、侧栏、活动栏、状态栏、标签页、面板、终端（16 色）、差异视图、列表、输入框、菜单、通知、面包屑，外加 19 条语法规则。

## 从源码打包

```bash
npx @vscode/vsce package
```

## License

MIT
