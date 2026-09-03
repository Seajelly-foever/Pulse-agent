---
name: project-task-extractor
description: 从已确认的项目语境、需求进展或用户明确指令中提取可独立执行和验收的项目 Todo，并识别负责人、截止时间、依赖、优先级与来源；个人提醒和定时任务不使用本 Skill。
---

# 项目 Todo 提取

## 目标

把项目材料中的下一动作转成独立、可执行、可追责、可验收的 Atomic Todo，避免把多个责任人、多个交付物或模糊计划揉成一条任务。

## 前置判断

先确认内容属于一个已知项目和具体 Requirement。无法确认项目归属时不创建项目 Todo；用户只是在讨论可能性、描述背景或表达建议时，不把内容自动变成任务。定时提醒交给 scheduled-task，非项目个人事项交给个人任务或收件箱能力。

## 提取规则

一条 Todo 只包含一个主要动作、一个可验证交付结果和一个主要负责人。负责人不同、交付结果不同、截止时间不同或依赖路径不同的事项必须拆分。协作者可以作为 participants 保留，但不能用多人名单代替单一 owner；确实共同负责且无法确定主责时，owner 标记待确认。

任务内容使用“动作 + 对象或交付结果”，避免把背景、进展和原因全部塞进标题。背景和依据放入 description 或 sourceEvidence。可以在一次工作中完成但没有独立交付价值的微小步骤不必过度拆分。

只有明确承诺、明确分工、已经确认的下一动作，或用户明确要求创建的事项才生成 Todo。问题、风险和依赖本身不是 Todo；只有存在对应处理动作时才生成任务。已经完成的事项作为进展证据，不重复生成未完成 Todo。

截止时间必须来自明确日期、可解析相对时间或已知里程碑。无法可靠解析时使用 null 并标记待确认。优先级依据对项目目标的影响、时间约束、阻塞关系和决策紧迫度综合判断；证据不足时使用默认优先级，不把措辞强烈程度当作唯一依据。

去重以 project、requirement、normalized action、deliverable、owner 和 dueDate 为核心。相同任务出现新的状态、负责人或日期时输出 update 建议，不重复 create。语义相近但交付结果不同的任务保持独立。

## 结构化输出

每条 Todo 包含 content、deliverable、owner、participants、dueDate、priority、status、dependencies、sourceEvidence、operation 和 confidence。operation 只能是 create、update、complete、cancel 或 needs_confirmation。缺失信息不得由模型补造。

Todo 必须挂在对应 Requirement 下。输出只表达模型判断，不代表已经写入；创建、更新、完成、取消、软删除和去重由 Task Service Tool 确定性执行。

## 验证

检查每条 Todo 是否只有一个主动作和主负责人；标题是否可理解且可验收；不同负责人或交付物是否已拆开；已完成事项是否被误建；日期和优先级是否有依据；是否存在重复；是否错误吸收了个人提醒或定时任务。工具执行后，再核对返回的项目、需求和 Todo 数量是否与批准的结构一致。
