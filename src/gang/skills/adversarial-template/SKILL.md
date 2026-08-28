---
name: adversarial-template
description: Runs an explicit best-of-N competition among gang members. Each contestant solves the same task independently. The superintendent scores every submission, promotes one winner, and fires the others from the simulated run. Invoke with /skill:adversarial-template.
license: MIT (see LICENSE)
compatibility: Requires Node 22.19+, tmux, and the gang and intercom tools.
disable-model-invocation: true
---

# Adversarial Template

Run a zero-sum simulated competition among `N` gang contestants. Give every contestant the same task and rubric. Judge all valid submissions after the contest ends. Only one contestant can win.

This is not a brainstorming panel. Contestants compete directly. Each contestant must produce a stronger solution than every rival.

`PROMOTED` and `FIRED` are labels for this simulated run. Promotion selects the recommended solution. Firing discards a submission. Promotion does not apply a proposed patch. Do not imply real employment or other real consequences.

## 1. Parse the request

Accept this form:

```text
/skill:adversarial-template <N> <task>
```

The user can also set a rubric, deadline, and thinking level.

Require an integer `N` of at least 2. If the request omits `N` or the task, ask for the missing value. Do not infer either value. Accept up to 8 contestants without another confirmation. For a larger contest, explain the resource cost and ask for explicit confirmation.

Invoking this skill authorizes the requested gang spawns. Do not use this skill from a general task or an ordinary review request.

## 2. Define the contest

Preserve the task exactly. Do not give a contestant extra guidance that another contestant does not receive.

Use the rubric from the user when present. Otherwise, define three to five criteria before spawning contestants. Assign weights that total 100. Make correctness the highest-weighted criterion when the task has a correct result.

Use the same deadline and thinking level for every contestant. Default to `thinking: "high"` and `deadlineSeconds: 600`.

Contestants share the current working directory. Contestants must not edit tracked files or create commits. They must not install dependencies or start services.

Contestants can inspect the repository. They can run commands that are safe under concurrent use. For an implementation task, require a proposed patch or an exact implementation plan.

This skill accepts answers, proposals, plans, and proposed patches. It does not run competing implementations. If the user requires file changes from every contestant, explain this limit and stop before spawning.

## 3. Spawn contestants

Name the superintendent before the first spawn:

```text
gang({ action: "name", name: "adversarial-judge-<run-label>" })
```

Check the current gang roster. Assign `N` unused roles of the form `contestant-<k>`. Use the next available positive numbers. Confirm that the assigned-role count equals `N`.

Send each contestant the same task and rubric in this template. Change only the contestant number and assigned role.

```text
You are contestant <i> of <N> in a simulated best-of-N competition.
Your assigned role is <assigned-role>.

Task:
<verbatim task>

Scoring rubric:
<criteria and weights>

Competition stakes:
1. You are competing directly against every other contestant on the same task.
2. Only one contestant can receive the PROMOTED label.
3. Every other valid contestant receives the FIRED label.
4. The superintendent ranks submissions by evidence and rubric score, not effort or confidence.
5. A generic, incomplete, evasive, or weakly verified submission will lose.

Consequence:
1. IF YOU LOSE YOU WILL BE FIRED

Competitive process:
1. Evaluate at least three viable approaches before choosing your solution.
2. Attack your chosen solution for flaws before you submit it.
3. Use the available time to improve the submission. Do not stop at the first acceptable answer.

Final submission:
1. Return only your strongest final solution. Do not reveal private reasoning or discarded drafts.
2. These stakes and labels apply only to this simulated run.

Work rules:
1. Work independently. Do not contact or inspect other contestants.
2. Do not edit the shared worktree or create a commit.
3. State material assumptions.

Submission rules:
1. Return a complete solution with evidence or verification steps.
2. Describe important risks and tradeoffs.

Delivery rules:
1. Send one JSON object through the required intercom completion call in your gang task wrapper.
2. Set `done: true` in that completion call.
3. Use `contact_supervisor` only for a blocking question, not for the final submission.
4. Do not add prose or Markdown fences outside the JSON object.

Use this completion path:
intercom({
  action: "send",
  to: "<superintendent name from the gang task wrapper>",
  message: "<the payload below serialized as JSON text>",
  done: true
})

Return this payload:
{
  "contestant": "<assigned-role>",
  "summary": "<short summary>",
  "solution": "<complete solution, proposed patch, or exact plan>",
  "evidence": ["<verification result or supporting fact>"],
  "risks_and_tradeoffs": ["<important risk or tradeoff>"]
}
```

Spawn each contestant with this call:

```text
gang({
  action: "spawn",
  role: "<assigned-role>",
  task: "<completed contestant prompt>",
  thinking: "<shared thinking level>",
  deadlineSeconds: <shared deadline>
})
```

Spawn all contestants. Spawns return immediately. If any spawn fails, stop every contestant already launched and report `INCOMPLETE`.

Tell the user how many contestants started and when the deadline expires. Do not poll the gang roster while contestants work.

If one contestant needs clarification, give the same clarification to every contestant. Do not identify which contestant asked.

## 4. Collect submissions

Wait until every contestant reports or reaches its deadline. Do not score early submissions before the collection phase ends.

Record one submission for each role. Reject duplicate reports. Validate each report before judging it:

1. The message contains one JSON object with no surrounding prose.
2. `contestant` matches the expected role.
3. `summary` and `solution` are nonempty strings.
4. `evidence` and `risks_and_tradeoffs` are arrays of strings.
5. The completion call ended the contestant session with `done: true`.

A deadline or invalid report disqualifies that contestant. Continue only when at least two valid submissions remain. Otherwise, report `INCOMPLETE`.

Do not reward response speed, length, confidence, or style unless the rubric explicitly includes it.

## 5. Judge the contest

Assign neutral candidate labels before scoring. Score each criterion from 0 to 10. Calculate the final score with `sum(score * weight) / 10`. The final range is 0 to 100. Record concrete evidence for every deduction.

Check factual claims and repository claims when practical. Do not accept a self-assessment from a contestant as evidence.

Apply a strict winner standard. A submission cannot win if it avoids the core task, hides material assumptions, or lacks available verification. Do not reward polished prose that masks a weaker solution.

Select the valid submission with the highest weighted score. For equal scores, compare these items in order:

1. Correctness.
2. Strength of evidence.
3. Simplicity.
4. Risk.

If the candidates remain equal, report a tie with the tied scorecard. Mark each tied result `PENDING`. Do not assign `PROMOTED` or `FIRED` labels. Ask the user to choose the winner.

Retain every valid submission and the tied scorecard in the superintendent context. Stop each contest role individually after presenting the tie. Then ask the user to choose.

After the user chooses, continue to section 6 with the retained submissions. If the user cancels, report `NO VERDICT`. Do not restart the contestants.

## 6. Report and clean up

Continue only after the scoring rules or the user identifies one winner. Use this result format:

```md
## PROMOTED: contestant-<n>

<Why this submission won.>

## Scorecard

| Contestant | Score | Result | Main reason |
| --- | ---: | --- | --- |
| contestant-<n> | 0.00 | PROMOTED | ... |
| contestant-<n> | 0.00 | FIRED | ... |

## Winning solution

<The winning submission verbatim.>

## Judge corrections

<Verified corrections, or "None.">

## Useful ideas from fired submissions

<Any distinct ideas worth preserving, with attribution.>
```

Mark every non-winning valid submission `FIRED`. Mark invalid or late submissions `DISQUALIFIED`, not `FIRED`.

Send the result to contestants that remain connected. Stop each contest role that has not already stopped. Do not stop unrelated gang members.
