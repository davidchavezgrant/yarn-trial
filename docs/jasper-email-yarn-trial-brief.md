# Jasper's email — Yarn trial project brief

Saved 2026-07-27 so it doesn't need repasting.

> Will send over a contractor doc ahead of time. Happy to give you repo access and can walk you how Yarn works 🙂 Can also go through bigger picture stuff, roadmap, stuff like that!
>
> But you'll be working on prototyping a self-driving demo feature independently. Basically we want reliablish computer use for a given web/Mac app.
>
> So let's say Notion Calendar as a random example you can say: "Show me how to change my timezone to Paris" and the agent will perform the action. (Yarn's an Electron Mac app and we have accessibility and screen recording permissions so stuff in this area should be doable).
>
> This should theoretically work on arbitrary apps, although we'd budget some setup time (e.g. 24 hours) for our system/agents to get a grounding in the app. It doesn't need to work real time (as it can take 30 mins to do the "Show me how to change timezone" sequence, we just want one end-to-end clean sequence of that happening).
>
> Not much idea, but maybe using something like Cua Driver under the hood.
>
> Lmk if any questions!

## Distilled requirements

- Prototype a **self-driving demo feature**: NL task → agent performs real UI actions on a web/Mac app.
- Canonical example: **Notion Calendar** — "Show me how to change my timezone to Paris" → agent does it.
- Yarn itself is an Electron Mac app with accessibility + screen recording permissions already granted.
- Should generalize to arbitrary apps, with acceptable per-app grounding/setup time (~24h budget).
- Not real-time: a 30-minute run is fine. Goal is **one clean end-to-end sequence**.
- Suggested substrate: Cua Driver.
