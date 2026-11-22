# 1. Record architecture decisions

Date: 2026-11-22
Status: Accepted

## Context
Holdfast is built in the open with Claude Code. Decisions made in chat are lost, and decisions made silently in code are hard to review or explain later. Token Keeper used ADRs this way and they paid off.

## Options considered
1. **ADRs in the repo**, reviewed in pull requests like code.
2. **Decisions in PR descriptions only.** No extra files, but scattered and hard to find once merged.
3. **A single design doc kept up to date.** One place to read, but the history of why things changed is lost.

## Decision
Option 1. Every decision that would be expensive to reverse gets a short ADR in `docs/adr/`, numbered in order, with the sections Context, Options considered, Decision, Why and Consequences (the kit's `templates/adr.md`).

An ADR is written with `Status: Accepted` in the pull request that introduces it. The PR is where it's debated, and merging is the acceptance. A merged ADR isn't rewritten: to change a decision, a new ADR supersedes it, and the old one stays, marked "Superseded by N". Typos and broken links can be fixed in place.

## Why
It's the same practice as Token Keeper, so reviewers and later Claude sessions find decisions in the same place in every project.

## Consequences
- The reasons behind the design are reviewable and survive the chat that produced them.
- No status bookkeeping after merge, and the record of changed minds stays intact.
- A small cost per decision; trivial choices don't need one.
