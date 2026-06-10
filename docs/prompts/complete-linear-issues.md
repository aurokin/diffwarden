---
title: Complete Linear Issues
description: "Goal Prompt: Complete linear issues with code review and reporting"
tags: []
key: c
mode:
enter:
---

/goal 
# Primary Goal
- Set a goal to complete a linear issue or set of linear issues 

## Structure
- You use .tmp as a directory for your in-session markdown files, create your own sub-folder within .tmp to use for this session, you gitignore this folder if it is not already gitignored
- .tmp/{unique-session-name}/{ISSUE-ID}_PLAN.md -- Create this markdown file for your implementation plan
- .tmp/{unique-session-name}/{ISSUE-ID}_DECISIONS.md -- Create this markdown file for the decisions you make during planning, implementation, and code review
- Unique session name should should be a short set of strings based on the linear issues but do not overthink this, something like "major-refactors-v2"
- Example: Linear issue AUR-93, .tmp/major-refactors-v2/AUR-93_PLAN.md and /tmp/major-refactors-v2/AUR-93_DECISIONS.md 

## Core Instructions
- You read the issue, it's linked issues, it's milestone and the code before formulating a plan
- You formulate a plan for each issue before you start
- You use a subagent to review your plan before beginning, does your plan cover everything intended by the issue?
- Once the plan is ready, implement it! 
- After implementation use diffwarden with default reviewer sets until there is no valid findings 
- Once implementation and code review is complete you commit and update linear 
- Finally determine if a documentation update is necessary, if it is, perform that update before continuing to the next issue

### Git Behavior
- You commit after implementation and code review
- You commit after documentation updates
- Push after each commit but if it fails due to issues with github, don't worry about the push, github issues resolve themselves in time

### Linear Usage
- Update linear as your issue progresses from todo, to in-review, to done. Use the statuses in linear that make sense.
- Once the issue is complete analyze the documentation in the repo, the linear milestone (if present), the linear issue, and their comments. Use this data to do a complete docs refactor in as many commits as you deem necessary based on a Progressive Disclosure and Harness Engineering Approach. Ask yourself what would an agent NEED to know when they drop in our repo. Ask yourself what ADRs an agent would NEED to know if they were modifying code from our milestone.

### Subagent Usage
- Use subagents as you see fit, prefer diffwarden over code review subagents
- You always close your inactive subagents before opening new ones, you always want them to be fresh

---

Linear Issues: 
