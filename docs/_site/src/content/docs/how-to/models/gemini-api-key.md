---
title: "Use a Gemini API key under a spend cap"
description: "Seal a Gemini API key in control, give its models to agents, stop spending at a monthly cap that you set, and disconnect or delete the key."
type: how-to
sidebar:
  order: 6
---

A **Gemini API key** is a key from [Google AI Studio](https://aistudio.google.com/). Control keeps the key and calls Google's Gemini API with it for the agents you choose. Thermite counts what each call costs and stops at a **monthly spend cap** that you set. When the cap is reached or a call fails, the call fails: Thermite tries no other provider, key or route.

The key never leaves control. A rig gets control's own address and a capability that works only there.

## What the cap does and does not cover

- The cap is **yours to set**, in US dollars for a calendar month in UTC. Thermite has no amount of its own, as a default or as a maximum. Until you set one, no key is added and every call is refused.
- It is **one cap for the whole control**: every Gemini API key, provider and agent counts toward it together. Disconnecting a key, deleting a provider, adding a new key or using a new name resets nothing.
- It counts **only calls made through this Thermite**. Anything else that uses the same key or the same Google project is not seen and not counted. A second control keeps a count of its own: use a key on one control only.
- The count is kept in control's store. Restoring an older backup of the store restores the count as it was then.
- It is counted from the usage Google reports for each call and from a dated table of Google's prices. It is Thermite's count, not Google's bill.
- **Credits and budget alerts at Google do not stop spending.** Thermite can't see whether credits cover a charge.

So set limits on Google's side too, as [Set limits at Google](#set-limits-at-google) says.

## Before you start

- You are signed in to the dashboard as the owner.
- Control has its public address set ([`THERMITE_CONTROL_PUBLIC_URL`](../../reference/settings.md)), and control can reach `generativelanguage.googleapis.com`.
- You have a Google account that can use Google AI Studio.

## Get a key and its billing ready

Do this in Google AI Studio, signed in with your own account. Thermite takes no part in it. Google changes these pages and terms: read them as they are on the day.

1. If your Google plan includes monthly developer credits, claim them on your [Google Developer Program benefits](https://developers.google.com/profile/help/benefits) page, and choose the Google Cloud billing account they go to. A month's credits arrive on the day of the month you first claimed them, not on the first, so Google's month and Thermite's calendar month differ.
2. In Google AI Studio, create or pick a project, and link it to that billing account.
3. Set up billing for the Gemini API. A new account is on **Prepay**: Google asks for a first purchase of credits, 5 US dollars at the least. [Google's billing page](https://aistudio.google.com/docs/billing) says that eligible Google Cloud credits can be used only after you have bought prepaid credits, and are then used before them.
4. Leave **auto-reload** off, or give it a monthly limit. With no balance left, Google answers every call with an error, which is the stop on Google's side.
5. Create an API key for the project. Copy it once.

Check on the billing page that the credits show on the billing account the project uses. Thermite does not know whether a charge is paid from credits or from your prepaid balance.

## Set the cap

1. Press the cog icon, **Settings**, at the foot of the sidebar. On **Providers**, follow **Gemini API key and spend** under **Add a provider**.
2. Under **No monthly cap is set**, enter the **Cap in US dollars** and press **Set the cap**.

You can raise or lower the cap at any time. A lower cap gives nothing back: what the month has counted stays counted. A cap of 0 refuses every call.

## Add the key

1. Under **Add a key**, enter a **Provider name**, for example `gemini-api`.
2. Paste the key into **Gemini API key**. The field hides what you type.
3. Tick the box that allows the agents to spend on this key when you are away, up to the monthly cap.
4. Press **Seal the key**.

Control seals the key in its store and never shows it again: not on a page, in a log, in the audit log or in an error. Sealing makes no call to Google.

## Test the key

Press **Test the key** on the provider's card. Control asks Google for the model list with the key: no content is requested and nothing is charged. The page then says how many of the listed models have a price in Thermite's table. Only those can be given to agents.

If Google refuses the key, the page says so in Thermite's words. Google's own message is not shown.

## Give a model to an agent

On **Edit rig**, choose the provider's model and the **Pi** harness for the workers, the planner or an advisor. Other agent programs are refused for this provider.

The rig never receives the key. Its route is control's own address and a capability that works only there. Control checks the capability, calls Google, and passes the answer back as it streams, with its tool calls, thought signatures and usage.

A rig must reach control at that address. Where the rig's harness reaches control at another address than control's public one, as in a compose stack on one machine, set [`THERMITE_HARNESS_CONTROL_URL`](../../reference/settings.md) on the rig's supervisor.

Run the rig's model check before a campaign. It makes one small paid call.

## How a call is counted

1. **Before the call**, control reserves its worst case: every byte of the request counted as one input token, plus 8,192 tokens, at the full input price; and the call's whole output limit at the output price. Thinking tokens are part of the output limit. A prompt that could pass a model's long-prompt threshold is priced at the long-prompt prices.
2. If the month's spend and this reservation would together pass the cap, the call is **refused and not sent**: the cap is reached.
3. If the call fits beside the month's spend, but not while other calls are open and hold their reservations, it is **told to wait**, as for a rate limit. Open calls settle at or under what they hold, so it may fit then. The same happens when 64 calls are open at once.
4. **After the call**, the reservation is settled to what the call cost: input, cached input, output and thinking tokens as Google reported them on the answer's last chunk, at the table's prices, rounded up.
5. **When the cost is not known**, the whole reservation is charged: an answer whose last chunk has no usage, or usage whose counts contradict each other; a call that was broken off, timed out or cut short; a call whose caller left or whose key was removed before its stream ended; and a call that was open when control stopped. Usage on an earlier chunk does not stand in for the last one's.
6. A call that never left control costs nothing. Neither does one that Google answered with HTTP 400 or 500: [Google's billing page](https://aistudio.google.com/docs/billing) says a request that fails with those is not charged. **Every other error status keeps the whole reservation**, among them a rate limit (429), a refused key (401), a gateway timeout (504) and a redirect: none of them is proof that nothing was billed.

So a key that Google refuses, or a rate limit that lasts, uses up the cap although Google may bill nothing. Test the key before you give its models to agents, and watch the first run.

Because the worst case is reserved, the last part of the cap may stay unspent: a call is refused when its worst case does not fit, although its real cost would have.

A call still open when the month turns stays reserved in the new month and is charged there.

### The output limit

Control sends every call an output limit: the agent's own, or **Most output tokens a call may ask for** on the page, whichever is lower. It is 65,536 unless you lower it. A lower limit reserves less for each call, and cuts a longer answer short.

### Prices

The page shows the table: US dollars per million tokens for each model, the page of Google's it was read from and the day it was read. A dated price change on Google's page counts from the day before its date.

- A model that is not in the table has no price and is **refused**. That includes models Google lists but the table does not hold.
- If Google raises a price before the table is updated, raise it on the page. A figure under the table's changes nothing: the higher always counts, so a price can't be lowered.
- **The prices count for 30 days** from the day the table was read, and then from the day you last reviewed them. The page says the day they count until. After it, every call is refused, and the page shows **The prices need your review**: compare the table with Google's price page, raise what Google has raised, and press **I have checked these prices today**. An old table is no evidence of today's bill, so Thermite does not go on counting with one unattended.
- If control can't read the prices you raised, every call is refused and the page shows **The raised prices can't be read**. Thermite does not count at the table's lower prices in their place. Press **Clear the raised prices**, then raise again each price that is still above the table's.

The table holds the Standard tier's text prices. The bridge accepts only text and declared function tools: no Batch, Flex or Priority tier, no audio or image input, no explicit cache and none of Google's own tools, which have other prices.

## At the cap

A refused call is answered with `HTTP 402` and the words that the monthly spend cap leaves no credits for the call. The agents read that as no credits left: they stop, and the run shows in **Needs you**. They start again after a model check passes, which is next month, or once you raise the cap.

Prices that need your review stop the agents the same way, with their own words.

Google's own answer that the billing account has no credits left is passed on the same way.

## Disconnect, replace or delete a key

Each provider has a card on the **Gemini API key and spend** page and a row on **Providers**. Both say where its key stands.

- **Disconnect** removes the key from Thermite and stops the provider's calls at once: its rigs get no route, and the capability they held opens nothing. Calls in flight are broken off and charged their whole reservation; the page says how many. The provider stays listed, so its rigs keep their models for a new key. Its card then says **disconnected**, with **Add a key under this name** and **Delete this provider**. Pressing Disconnect again changes nothing and is no error.
- Adding a key under an existing provider name replaces it. The routes the rigs held for the old key stop at once.
- **Disconnect and delete**, on the card and on the provider's row on **Providers**, does both as one step. It is refused while a rig still uses one of its models: the row then names those rigs, also a rig that does not report now. Give them another model first.

Two more states have their own card:

- **Removal not finished**: Thermite stopped the provider's calls, but control's store did not take the removal, for example because its disk is full. The key is then still sealed in the store, and its calls stay refused. Press **Finish removing the key**, or **Disconnect and delete**, to finish.
- **Its key can't be opened**: control can't open what it sealed, because its secrets key changed or the stored value is damaged. Its calls are refused. Press **Disconnect**, or add the key again under the same name.

None of these changes what the ledger has counted, and a provider added again under the same or another name starts no new count. Disconnecting removes the key from Thermite only: delete the key in Google AI Studio too if it should stop working everywhere.

## Set limits at Google

Thermite's cap is one of two limits. Set the other at Google:

- Keep a small prepaid balance with auto-reload off, or with a monthly auto-reload limit.
- In Google AI Studio, set a **monthly spend cap** for the project. Google calls it experimental and says spending can pass it for about ten minutes.
- In Google Cloud Billing, add a **budget** with alerts for the billing account. An alert tells you; it stops nothing.
- Use the key for Thermite only, so that Thermite's count is the key's whole use.

## Troubleshooting

| What you see | What it means | What to do |
| --- | --- | --- |
| `Set the monthly spend cap first` | No cap is set, so no key is added | [Set the cap](#set-the-cap) |
| `HTTP 402 … monthly spend cap` | The month's count, with this call's worst case, would pass the cap | Wait for next month, raise the cap, lower the output limit or use a cheaper model |
| `HTTP 402 … no monthly spend cap is set` | The cap's setting is gone or can't be read | Set the cap again on the page |
| `HTTP 402 … Google reports no credits left` | Google's billing account has no balance | Add credits in Google AI Studio |
| `HTTP 402 … prices need the owner's review` | The prices were last checked more than 30 days ago, or the raised prices can't be read | Review the prices, or clear the raised ones, on the page: [Prices](#prices) |
| `HTTP 402 … spend ledger can't be read` | Control's record of the month's spend is damaged | Repair it with whoever runs control; nothing is spent until then |
| `HTTP 404 … no dated price` | The model is not in Thermite's price table | Use a model from the table |
| `HTTP 401 … bridge capability refused` | The key was disconnected or replaced, or the rig's route is old | Add a key under the provider's name; the rig takes its new route by itself |
| `HTTP 401 … Google refused the Gemini API key` | Google refused the key | Check the key and its project's billing in Google AI Studio |
| `HTTP 429` | Google's rate limit, or a call that waits for open calls to settle | The agents wait and try again. A rate limit from Google keeps the call's reservation |
| `The removal could not be saved` | Control's store refused the removal; the provider's calls are stopped all the same | Press **Finish removing the key**, and look at control's disk |

Raised cache or input rates can exceed the output rate. Reservations cover those higher rates as well; tokens reported without a known category count at the highest effective rate.
