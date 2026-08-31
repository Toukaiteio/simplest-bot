import assert from "node:assert/strict";
import { filterRelationsToCurrentGroup } from "./social-plugin.js";

const relations: Array<[string, number]> = [
  ["current-user", 100],
  ["group-a-member", 80],
  ["group-b-only-member", 9999],
];
const groupA = new Map([
  ["current-user", { userId: "current-user", card: "当前用户" }],
  ["group-a-member", { userId: "group-a-member", card: "群A成员" }],
]);

const visibleInGroupA = filterRelationsToCurrentGroup(relations, groupA);
assert.deepEqual(visibleInGroupA.map(([userId]) => userId), ["current-user", "group-a-member"]);
assert.equal(visibleInGroupA.some(([userId]) => userId === "group-b-only-member"), false, "群 B 独有成员不得出现在群 A");
assert.deepEqual(filterRelationsToCurrentGroup(relations, new Map()), [], "成员列表验证失败时不得回退全局数据");
assert.equal(filterRelationsToCurrentGroup(relations, null).length, 3, "私聊仍可显示用户自己的全局关系数据");
console.log("✅ $me 当前群隔离、失败关闭和私聊行为均正确");
