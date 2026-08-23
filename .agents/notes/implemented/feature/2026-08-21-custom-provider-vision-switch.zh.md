# Agent Note: 自定义提供方卡片为整条路由声明视觉能力

Status: implemented

[English](2026-08-21-custom-provider-vision-switch.md) | 中文

## 问题

模态声明落在了 settings 文档里：一个手写的 pi-ai 模型要接受图片，必须有人在它的条目上写下 `input: [text, image]`，或在路由上写下 `defaultInput: [text, image]`（[路由默认输入模态](../architecture/2026-08-12-pi-ai-route-default-input-modalities.md)）。但 Web UI「添加自定义提供方」卡片创建的模型恰恰全是这种手写模型——它们没有任何已安装 catalog 条目——而卡片上没有一个字段触及模态。一个把卡片指向提供视觉模型的 OpenAI 兼容网关的纯 Web 用户，得到的是所有模型都报告 `inputModalities: ['text']` 的路由，而补救办法躺在他没有理由打开的文件里：模型选择器不隐藏任何东西，准入诊断只会点名该模型，页面上没有任何东西指向那一个能改变三个准入点接纳范围的关键。

## 决策

**创建卡片承载一个能力开关「支持视觉（图像输入）」，它写入的是路由级 `defaultInput`——而不是任何条目的 `input`。** 勾选时，卡片在 `providers.<route>` 上设置的 profile 携带 `defaultInput: ['text', 'image']`；不勾选时该字段缺省，由适配器自己的 `[text]` 回退值作答。选择缺省而非明写 `['text']`：存储的 profile 不应携带适配器本来就会作答的声明，两者效果不可区分，而只有前者在未来回退值变化时无需改写 settings 即可存活。

**开关默认关闭。** 路由默认值的 note 已经定下了猜错的非对称代价——少声明在图像被附加之前就拒绝它，多声明则在消息已持久化之后毒化会话——而一张 Web 表单无从知道自己处在这条非对称的哪一侧。没有任何东西能向网关询问它的模态，因此默认值是安全的一侧，而不是猜测。

**开关只存在于创建卡片。** 一条手写路由的所有模型都从同一级解析模态——条目的 `input`（卡片从不写入）然后是路由的 `defaultInput`——所以一个路由级声明就覆盖了它列出的每个模型，这正是「该网关提供图像」的含义。编辑器卡片保持原样：在那里编辑的手写路由可能已经被人手写了按模型的 `input` 字段，而并置其上的提供方级控件只可能被设成其中一些模型会拒绝的值——与这两张卡片把推理等级排除在外是同一个理由。

**开关随创建卡片既有的写入一并落盘。** 它是卡片本就要执行的那次整体 profile `settings.mutate` 的字段之一，profile 写入落地后与其他 profile 字段一样被同一个 `profileDisabled` 禁用，且它不门控任何东西：视觉是关于端点的声明，不是端点的前提。

## 备选方案

- **模型列表编辑器里的按模型视觉复选框**——写入每行自己的 `input`，让一条路由可以从表单上混合视觉与纯文本模型。被否决的理由是它换来的界面：卡片的全部流程（获取可用模型、手工键入 id）服务于共享同一端点与同一能力集的网关；按模型的层级在 `settings.yaml` 里仍然可写，混合场景有处可去；而在三十个模型的列表上每行一个复选框，恰恰是路由字段被引入时要消灭的那种重复。
- **乐观的 `[text, image]` 默认值**——已在 resolver 层因猜错的严重性不对称被否决（[路由默认输入模态](../architecture/2026-08-12-pi-ai-route-default-input-modalities.md)）；一个表单默认值是同一个选择，只是可见性更低。
- **在编辑器卡片上也暴露该开关**——可以让手写路由在创建后翻转整条路由的声明，但只能在可能并置着手写按模型 `input` 字段的情况下改写 `defaultInput`；对既有路由的这类修正仍归 settings 文档所有，而创建卡片才是带着完整知晓在被声明什么的前提下做出该声明的地方。

## 影响

纯 Web 用户在创建时勾一个复选框即声明了一个视觉网关：profile 携带 `defaultInput: [text, image]`，路由上每个模型都报告 `inputModalities: ['text', 'image']`，三个准入点与 `read_image` 无需一行 `settings.yaml` 即可在其上工作。存储的 profile 与 settings 文档补救路径产生的内容逐字节一致，因此下游没有任何东西能区分两种来源。

创建卡片如今写入的是用户勾选做出的模态声明；resolver 的信任模型不变——该声明不与端点核验，多声明的网关仍会在消息已持久化之后、回合中途失败。默认关闭的开关保住了每个既有流程的出厂行为：不碰开关就保存的卡片根本不写 `defaultInput`。

编辑器卡片刻意保持对模态的盲视；修正既有路由上某个模型的声明是 settings 文档的编辑，正如[路由默认值的 note](../architecture/2026-08-12-pi-ai-route-default-input-modalities.md)已经为 `input` 决定过的那样。

## 测试

`packages/client/ui-settings-models/tests/provider-form.client.spec.tsx` 通过记录的 wire 写入固定了开关的两个方向：勾选时，创建的 profile 在 models 列表旁携带 `defaultInput: ['text', 'image']`；不勾选（默认）时，写入的 profile 根本没有 `defaultInput` 键。卡片字段范围用例把该开关列入一个提供方可以拥有的字段之中；它所供给的 resolver 侧行为由链条所在处覆盖，即 `packages/llm/llm-pi-ai/tests/catalog.spec.ts`。
