// prompt 源的原始字符串导入。Vite/Vitest 原生支持 `?raw`；
// tsdown 使用共享的 `raw-text-plugin` 实现相同的导入形式。

declare module '*?raw' {
  const content: string;
  export default content;
}
