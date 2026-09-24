# Documentation style

Tilecast technical documentation follows ASD-STE100 Simplified Technical
English, Issue 9. The standard uses writing rules and a controlled dictionary.
It helps readers understand instructions and system behavior.

This guide applies to README files, `docs/`, the source-controlled wiki, API
descriptions, and operator messages. Product names, API names, code, commands,
file names, and quoted text remain exact technical terms.

Engineering specifications, contracts, implementation records, and
operator-grade technical material use this guide. The public documentation site
has a different reader and a different style. Pages below
`apps/docs/src/content/docs/` follow
[`apps/docs/STYLE.md`](../apps/docs/STYLE.md), not this guide.

## Writing rules

- Use one action or fact in each sentence.
- Use active voice. Name the person, Player, Server, or system that performs the action.
- Use the simple present for system behavior.
- Use the imperative for procedures. Put a required condition before the action.
- Use `must` for a requirement, `may` for permission, and `can` for ability.
- Use one term for one function. Do not change a term to create variety.
- Use short sentences and common words. Remove idioms, metaphors, filler, and marketing language from technical instructions.
- Use a list when a sentence contains more than one independent action.
- State limits, failure behavior, and recovery action next to the related step.
- Do not use `and/or`, `etc.`, or an unexplained pronoun.

## Technical terms

Tilecast-specific terms are technical terms. Keep their spelling and case:

- Tilecast Server
- Tilecast Studio
- Tilecast Player
- Display Group
- AirPlay Present
- Content Review
- Player configuration
- installation ID
- device credential

Use code formatting for API paths, JSON fields, setting keys, commands,
environment variables, file names, and enum values. Do not translate or replace
these terms.

## Procedure pattern

Use this order for an operator procedure:

1. State the condition or warning.
2. State the action.
3. State the expected result.
4. State the recovery action when the result is not obtained.

Example:

> If a Player process is running, do not start the systemd unit. Enable the
> unit. Restart the Player at the next controlled restart.

Use the [official ASD-STE100 site](https://www.asd-ste100.org/) as the source
for the complete rules and dictionary.

## Conformance check

Run `make docs-check` from the repository root. The check scans the root
README, every `README.md`, `docs/`, and `wiki/`. It does not scan the public
pages below `apps/docs/src/content/`. It reports contractions, vague wording,
`and/or`, `etc.`, and imprecise conjunctions.

The check does not replace an editorial review. A qualified reviewer must still
check sentence structure, approved dictionary terms, procedure order, and
technical accuracy.
