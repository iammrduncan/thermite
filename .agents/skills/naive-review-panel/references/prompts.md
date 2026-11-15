# Prompts

The templates for a naive panel. Placeholders are in `[CAPS]`. Fill in every one before you send a prompt, and check that none is left. The fxbot versions, from the first impressions phase, are the examples.

Every prompt keeps three things word for word:
- "Do not search the web, fetch anything, or read any files"
- answer only from the text given
- the confidence (fresh readers) or the word limit (personas)

## Fresh reader: a link preview

```text
You are playing a person who has never heard of this product. A friend just texted you a link, and all you see is the link preview below. Do not search the web, fetch anything, or read any files: answer only from this text, the way a person skimming a text message would.

The link preview, from [DOMAIN]:
- Image: [THE CARD, DESCRIBED IN WORDS]
- Page title: "[OG_TITLE]"
- Description: "[OG_DESCRIPTION]"

Answer briefly and honestly, one or two sentences each, with your best guess when unsure, and say how sure you are (low/medium/high):
1. What is this thing? What kind of product is it?
2. What would you use it for? Name a task.
3. Where does it run? Is it a website, an app, a browser extension, a server, something else?
4. What would you need to have or install to use it?
5. [MODELS_QUESTION]
6. [PHONE_QUESTION]
7. What does "[CONCEPT_WORD]" mean here?
[8. AND ON: ONE TARGETED QUESTION FOR EACH CONFUSION NOT COVERED ABOVE]
[LAST]. What three questions would you text back to your friend before trying it?
```

The fxbot version, as it was run. The preview's three lines held the card and the meta tags of the day, which the phase doc's research quotes:

```text
You are playing a person who has never heard of this product. A friend just texted you a link, and all you see is the link preview below. Do not search the web, fetch anything, or read any files: answer only from this text, the way a person skimming a text message would.

The link preview, from fxbot.sh:
- Image: [the card, described in words]
- Page title: "[og:title]"
- Description: "[og:description]"

Answer briefly and honestly, one or two sentences each, with your best guess when unsure, and say how sure you are (low/medium/high):
1. What is this thing? What kind of product is it?
2. What would you use it for? Name a task.
3. Where does it run? Is it a website, an app, a browser extension, a server, something else?
4. What would you need to have or install to use it?
5. Does it work with ChatGPT, Claude, or other hosted AI models, or only local ones?
6. How would you use it from your phone?
7. What does "plugins" mean here?
8. What three questions would you text back to your friend before trying it?
```

## Fresh reader: the first screen

The same questions, after the first screen in order. Describe the screenshot as a person would see it, including what its address bar says, since a reader takes a real address as a requirement.

```text
You are playing a person who has never heard of this product. A friend just texted you a link, and you opened it. Below is everything on the first screen, in the order you'd see it, then the get-started steps further down. Do not search the web, fetch anything, or read any files: answer only from this text, the way a person skimming a web page would.

The first screen of [DOMAIN]:
- Headline: "[HEADLINE]"
- Paragraph: "[PARAGRAPH]"
- Commands: [COMMANDS, EXACTLY AS SHOWN]
- Small print: "[SMALL_PRINT]"
- Buttons: "[BUTTON]", "[BUTTON]"
- Screenshot: [WHAT IT SHOWS, IN WORDS, AND WHAT ITS ADDRESS BAR SAYS]
- Caption: "[CAPTION]"

Get started, further down:
1. [STEP]
2. [STEP]
3. [STEP]

Answer briefly and honestly, one or two sentences each, with your best guess when unsure, and say how sure you are (low/medium/high):
[THE SAME QUESTIONS AS THE LINK PREVIEW]
```

## Targeted questions

Turn each confusion people reported into an open question that doesn't give the answer. Often a core question already covers it. In the fxbot run:

| What people asked | The questions that test it |
| --- | --- |
| "Does it only work with local models?" | 5, on models |
| "Like a plugin for the browser?" | 3, where it runs, and 7, what plugins mean |
| "But that requires Tailscale." | 4, what you'd need, and 6, the phone |

A good targeted question asks what they'd do or need. A bad one names the answer: "Do you need Tailscale?" plants Tailscale.

## Persona panel

```text
You are role-playing a member of the public for a quick product-wording survey. Persona: [PERSONA_LINE] Stay in character: answer the way [NAME] would, from what [THEY]'d know, in [THEIR] own words. Do not search the web, fetch anything, or read any files.

Part 1. In apps and software you use, what does each of these words mean to you? One line each, with an example you've seen if one comes to mind: [WORDS, IN THIS PERSONA'S ORDER].

Part 2. A friend texts you a link to a new product, [PRODUCT]. The link preview says: "[PREVIEW_TEXT]" The page adds: "[PAGE_LINE, WITH ___ WHERE THE WORD GOES]" For each word below put in the blank, say in one line what you'd expect one of those to be for [PRODUCT], where you'd go to get or install it, and [TARGETED_QUESTION]. Words: [WORDS, IN THIS PERSONA'S ORDER].

Part 3. Which word makes it clearest what you'd be adding to [PRODUCT], and which is most misleading? A sentence each, why.

Part 4. [COUNT] possible headlines for [PRODUCT]'s home page. For each, say in one line what you think the product is. Then pick the one that tells you most clearly what it is, and the one that makes you most want to try it:
A. "[HEADLINE, IN THIS PERSONA'S ORDER]"
B. "[HEADLINE]"
C. "[HEADLINE]"
D. "[HEADLINE]"

Keep the whole answer under 450 words.
```

The fxbot version, as it was run for the shop owner. `[TARGETED_QUESTION]` there is "whether you'd think it goes in your web browser", from the friend who asked whether fxbot was a plugin for the browser:

```text
You are role-playing a member of the public for a quick product-wording survey. Persona: Dana, 38, runs a small online shop. Uses Shopify apps, Zapier integrations, Google Workspace add-ons, and ChatGPT daily for emails. Not a programmer. Stay in character: answer the way Dana would, from what she'd know, in her own words. Do not search the web, fetch anything, or read any files.

Part 1. In apps and software you use, what does each of these words mean to you? One line each, with an example you've seen if one comes to mind: integrations, apps, plugins, add-ons, extensions, skills.

Part 2. A friend texts you a link to a new product, fxbot. The link preview says: "fxbot — Your AI assistants, built the way you want them. Any model. Any device. Free and open source." The page adds: "Make AI assistants that chat, remember, work on a computer of their own, and run tasks on a schedule. Add only what you want: ___." For each word below put in the blank, say in one line what you'd expect one of those to be for fxbot, where you'd go to get or install it, and whether you'd think it goes in your web browser. Words: integrations, apps, plugins, add-ons, extensions, skills.

Part 3. Which word makes it clearest what you'd be adding to fxbot, and which is most misleading? A sentence each, why.

Part 4. Four possible headlines for fxbot's home page. For each, say in one line what you think the product is. Then pick the one that tells you most clearly what it is, and the one that makes you most want to try it:
A. "Your AI assistants, built the way you want them."
B. "AI assistants that do real work. Built your way."
C. "Your bot, built and configured how you want it."
D. "Your own AI assistants, on your own machine."

Keep the whole answer under 450 words.
```

Testing only words? Drop Part 4. Only headlines? Drop Parts 1 to 3, and give the preview without the blank.

## The six personas

Each line goes in `[PERSONA_LINE]`. Dana's is the one used. The other five are written in its shape, from the panel in the phase doc. Names are made up.

| # | `[PERSONA_LINE]` |
| --- | --- |
| 1 | Linda, 56, a school administrator. Uses an iPhone and the ChatGPT app. Not technical. |
| 2 | Jordan, 20, a college student. Uses Discord, Chrome extensions, and game mods. Not a programmer. |
| 3 | Sam, 34, a software engineer. Uses VS Code, Claude Code, and Ollama every day. |
| 4 | Marcus, 41, a sysadmin. Runs Docker and Tailscale, and looks after WordPress sites and their plugins. |
| 5 | Dana, 38, runs a small online shop. Uses Shopify apps, Zapier integrations, Google Workspace add-ons, and ChatGPT daily for emails. Not a programmer. |
| 6 | Priya, 29, a designer. Uses Figma plugins and Raycast extensions every day. Not a programmer. |

A new persona names the tools they use every day, and how technical they are. Leave out adjectives such as "savvy" or "skeptical", and anything about the product.

## Rotating the order

Move the list one place for each persona, so each option leads at least once. Today's version stays in the list as a control.

Words, six of them, one place per persona:

| Persona | Order |
| --- | --- |
| 1 | w1, w2, w3, w4, w5, w6 |
| 2 | w2, w3, w4, w5, w6, w1 |
| 3 | w3, w4, w5, w6, w1, w2 |
| ... | and so on, to persona 6 |

Headlines, four of them, one place per persona, starting over at persona 5. The letters A to D are positions, so keep a key for each persona:

| Persona | A | B | C | D |
| --- | --- | --- | --- | --- |
| 1 | h1 | h2 | h3 | h4 |
| 2 | h2 | h3 | h4 | h1 |
| 3 | h3 | h4 | h1 | h2 |
| 4 | h4 | h1 | h2 | h3 |
| 5 | h1 | h2 | h3 | h4 |
| 6 | h2 | h3 | h4 | h1 |

Map each pick back through the key before you count it.

## Recording it in the phase doc

In section 1, Research, in the shape the first impressions phase used:

```markdown
### [WHAT WAS TESTED], on fresh readers

[N] fresh readers, each a model told to answer only from what it was shown, as a person skimming would:

**One saw only [SURFACE].** They said:
- What it is: "[QUOTE]," [CONFIDENCE] confidence.
- [TOPIC]: "[QUOTE]"
- Their first question back: "[QUOTE]"

[ONE LINE: DID THEY ASK BACK WHAT REAL PEOPLE ASKED?]

### The words, on a panel of six

Six fresh readers, each a model playing a common kind of person, answered from [SURFACE], with the order of the choices changed for each:
- [PERSONA, AGE, WITH THEIR TOOLS]

It's a quick read on what words suggest, not a survey of people. [A person checks it](#4-checklist).

**Headlines:**

| Headline | Clearest | Most want to try | What they said |
| --- | --- | --- | --- |
| "[HEADLINE]" | [N] | [N] | "[QUOTE]" "[QUOTE]" |
| "[HEADLINE]" (today's) | [N] | [N] | "[QUOTE]" |

**Words for [CONCEPT]**, each put in "[PAGE_LINE WITH ___]":

| Word | What it meant to them | Would it go in the browser? | Their verdict |
| --- | --- | --- | --- |
| [WORD] | [MEANING, WITH THEIR EXAMPLES] | [N] said yes, [N] no, [N] maybe | [WHO FOUND IT CLEAREST OR MOST MISLEADING, AND WHY] |
```

In section 4, Checklist, the proof:

```markdown
Proof:
- [ ] [N] fresh readers, given only the new [SURFACE], as in [the research](#[ANCHOR]), with the same questions. Each says, with medium or high confidence, that:
  - [WHAT IT IS]
  - [THE FACT PEOPLE GOT WRONG]
  Their answers go in [What the build changed](#what-the-build-changed).

Only a person can check:
- [ ] [THE SURFACE], sent to three people who've never heard of [PRODUCT], asking: "[TWO OR THREE OF THE SAME QUESTIONS]"
```
