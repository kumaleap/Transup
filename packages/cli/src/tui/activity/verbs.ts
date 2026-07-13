// spinner 动词表：每个 turn 挂载时随机取一次，turn 内不轮换。
// 纯模块——不 import React/Ink；返回值不带省略号，"…"（U+2026）由渲染层追加。

/** 中性英文动名词表（含少量彩蛋），24~40 个 */
export const SPINNER_VERBS: readonly string[] = [
  "Thinking",
  "Brewing",
  "Composing",
  "Distilling",
  "Pondering",
  "Percolating",
  "Simmering",
  "Weaving",
  "Musing",
  "Sketching",
  "Refining",
  "Synthesizing",
  "Untangling",
  "Polishing",
  "Assembling",
  "Incubating",
  "Mulling",
  "Crafting",
  "Deliberating",
  "Calibrating",
  "Sifting",
  "Kneading",
  "Marinating",
  "Noodling",
  "Sculpting",
  "Conjuring",
  "Transmuting", // 彩蛋：向 Transup 致意
  "Moonwalking", // 彩蛋
];

/**
 * 随机采样一个动词。random 注入便于测试确定性（默认 Math.random）。
 * random() 约定返回 [0, 1)；防御性 clamp 保证 random()===1 也不越界。
 */
export function sampleVerb(random: () => number = Math.random): string {
  const index = Math.min(
    SPINNER_VERBS.length - 1,
    Math.max(0, Math.floor(random() * SPINNER_VERBS.length)),
  );
  return SPINNER_VERBS[index]!;
}
