---
name: naive-review-panel
description: Test what words, headlines, link previews, and first screens make people think, before a person ever sees them. Runs a panel of fresh model readers, each a separate subagent who knows nothing about the product. Some see only one surface and say what they think it is. Six more play common kinds of people and judge candidate words and headlines. Reports in tables, in the readers' own words, and records the panel in the phase doc. Use when the owner asks to test a headline, tagline, or link preview, asks what people will think something means, wants a first impression checked, is naming a concept (plugins, add-ons, or extensions), is writing onboarding or quickstart copy, says people don't understand what the product is, or says to run a panel, even without naming the skill.
---

# Naive panel

Find out what a piece of copy makes people think, before a person sees it. Fresh model readers, each a separate subagent who knows nothing about the product, read only what a stranger would see, and say what they think it is. Then six more, each playing a common kind of person, judge the candidate words and headlines.

It's model role-play. It shows a direction. It isn't a survey of people. Say so every time you report it, and leave the last check to a real person.

The worked example is the first impressions phase doc, `docs/_completed/phases/first-impressions.md`. Before your first run, read its sections "Today's first impression, on fresh readers" and "The words, on a panel of six". The prompt templates are in [references/prompts.md](references/prompts.md).

## When to use it

- Taglines, headlines, and a page's first screen.
- Link previews: the card, the title, and the description.
- Naming a concept, such as plugins, add-ons, or extensions.
- Onboarding and quickstart copy.
- Any time people misunderstand what the product is. Bring the questions they actually asked.

Not for:
- **UI flows.** Those need real screenshots, or a run in Playwright.
- **Facts.** Whether a claim is true needs a source, not a reader.
- **What only real users can tell you,** such as whether they'd pay, come back, or trust it.

## Ground rules

- **Readers know only the text they're given.** Tell each one not to search the web, fetch anything, or read files. Don't explain the product beyond what the surface shows. If the page doesn't say it, the reader doesn't know it.
- **One agent per reader.** Never one model playing six people. Their answers drift toward each other.
- **Don't lead.** Ask what they think it is, not whether it's an X. Don't hint at the answer you want, or say which option is new.
- **Rotate the order** of words and headlines for each persona, and include today's version as a control.
- **Ask for confidence** (low, medium, or high) and for what they'd ask back. A low-confidence guess is a finding too.
- **Don't let one persona decide.** Look for what most of them agree on, and note where one kind of person differs.
- **Remember this is a public repo.** What you record names no real person, private host, or home path. The personas are made up.

## 0. Scope

Before writing a prompt, gather:
- **The surfaces.** Write out in words what a stranger sees first, in the order they'd see it. Copy the text exactly as it is today.
  - A link preview: the card image, the page title, and the description.
  - A first screen: the headline, the paragraph, commands, small print, buttons, the screenshot (with what its address bar says), the caption, and the get-started steps.
- **The confusions people reported,** in their own words. Each one becomes a targeted question.
- **The candidates:** words for a concept, and headline variants, with today's among them.
- **What's true:** a line each on what the product is, which models it uses, where it runs, and how you reach it. You'll check answers against it. Readers never see it.

Tell the owner in two lines what you'll test, then go on.

## 1. Fresh readers

Start one reader per surface, each in its own agent, from the fresh-reader template. Each answers as a person skimming, in one or two sentences a question, with a confidence. The questions cover:
- what it is, and what they'd use it for
- where it runs, and what they'd need
- which models it works with
- how they'd use it from a phone
- what "plugins" (or the concept being named) means here
- a targeted question for each confusion people reported
- three questions they'd text back

If fresh readers ask back what real people asked, the copy causes the confusion, not the readers. Say so when it happens.

## 2. The persona panel

Start six readers, one per persona, each in its own agent. A persona is a common kind of person, defined by the tools they use, not by adjectives. The default six, written out in the reference:
- a school administrator, 56, with an iPhone and the ChatGPT app
- a student, 20, on Discord, with Chrome extensions and game mods
- a software engineer, 34, with VS Code, Claude Code, and Ollama
- a sysadmin, 41, with Docker, Tailscale, and WordPress plugins
- a shop owner, 38, with Shopify apps, Zapier, and Google Workspace add-ons
- a designer, 29, with Figma plugins and Raycast extensions

Change them only when the audience is clearly different, and keep each one's tools concrete.

Each persona answers four parts, in under 450 words in all:
1. **The words in general:** what each candidate word means to them, with an example.
2. **The word in context:** each word in the blank of a short preview. What they'd expect, where they'd get it, and whether it goes in their web browser. Swap that last part for the confusion at hand.
3. **The clearest word and the most misleading one,** with why.
4. **The headlines:** what each says the product is. Then the clearest one, and the one they most want to try.

Rotate the order of the words and the headlines one place per persona, as the reference shows. Keep a key, so you can map each pick back to its headline.

Testing only words, or only headlines? Drop the other parts.

## 3. Run it

- **Start every agent at once,** in the background, on a cheaper model. Sonnet works. Each costs about 30k tokens and a few seconds.
- **Make each prompt stand alone.** Fill in every placeholder, and check that none is left. Paste the surface in. Don't point to a file.
- **Give readers no tools** if the harness allows it. The prompt tells them not to use any either way.
- **Wait for all of them** before you tally. Never write a reader's answer yourself.

## 4. Tally

Report in tables, and quote the readers' own words:
- **Fresh readers:** each question, what they said, their confidence, and whether it matches what's true. Then the questions they'd text back.
- **Headlines:** the headline, how many found it clearest, how many most want to try it, and short quotes. Mark today's.
- **Words:** the word, what it meant to them, how many said it goes in the browser (or the answers to the swapped question), and the verdict.

Then write the takeaways, a line each. Record the panel in the phase doc's research: who the readers were, what they saw, the tables, and the line that it's role-play and a person checks it. Follow [the research directive](../../../docs/research-directive.md): takeaways go in section 2, and the proof goes in the checklist. The reference has a skeleton.

## 5. Prove the change

After the copy changes, run the same test again. Use the same questions, with the surfaces rewritten from the new copy.
- **Write the pass bar first,** in the phase doc's checklist: what each reader should say, with medium or high confidence.
- **Record the new answers** in the phase doc's "What the build changed". A miss is a finding. Don't explain it away.
- **Add a checklist line only a person can tick:** the new surface, sent to a few people who've never heard of the product, with the same few questions.

## Pitfalls

- **Explaining too much.** A prompt that says what the product really is tests nothing.
- **Leading.** "Is it clear this works with Claude?" tells them it does. Ask "Which models does it work with?"
- **One model playing six people.** Their answers converge. Use separate agents.
- **A fixed order.** The first option gets picked more. Rotate.
- **Vague personas.** "A tech-savvy millennial" gives generic answers. "Uses Figma plugins and Raycast extensions" gives real ones.
- **No doubt and no questions back.** Without them, every guess reads as certain.
- **Reading it as a survey.** "4 of 6" is a direction. Don't write it as a percentage.

## Hand-off

End with one short message:
- the tables, and two or three takeaways
- the line that this is model role-play, directional, and that a person still checks it
- what changed in the phase doc
- what only a person can check
