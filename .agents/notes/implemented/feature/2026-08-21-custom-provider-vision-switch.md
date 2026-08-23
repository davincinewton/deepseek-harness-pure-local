# Agent Note: The custom provider card declares vision for its whole route

Status: implemented

English | [中文](2026-08-21-custom-provider-vision-switch.zh.md)

## Problem

The modality declaration landed in the settings document: a hand-declared pi-ai model takes images only when someone writes `input: [text, image]` on its entry, or `defaultInput: [text, image]` at the route ([route default input modalities](../architecture/2026-08-12-pi-ai-route-default-input-modalities.md)). But every model the web UI's "add a custom provider" card creates is exactly such a hand-declared model — no installed catalog entry exists for it — and the card offered no field that touches modalities at all. A web-only user pointing the card at an OpenAI-compatible gateway that serves vision models got a route whose models report `inputModalities: ['text']`, and the remedy lived in a file they have no reason to open: the model picker hides nothing, the admission diagnostics only name the model, and nothing on the page points at the one key that would change what the three admission points admit.

## Decision

**The create card carries one capability switch, "vision enabled", and it writes the route-level `defaultInput` — never an entry's `input`.** Checked, the profile the card sets at `providers.<route>` carries `defaultInput: ['text', 'image']`; unchecked, the field is omitted and the adapter's own `[text]` fallback answers. Omission rather than `['text']` spelled out: the stored profile must not carry a claim the adapter already answers for, and the two are indistinguishable in effect while only one survives a future change to the fallback without a settings rewrite.

**The switch is off by default.** The route-default note already fixed the asymmetry of a wrong answer — under-claiming refuses the image before it is attached, over-claiming poisons the session after the message is durable — and a web form has no way to know which side of the asymmetry it is on. Nothing interrogates a gateway for its modalities, so the default is the safe side, not a guess.

**The switch is create-card-only.** A hand-declared route's models all resolve their modalities from the same rung — entry `input` (never written by the card) then route `defaultInput` — so one route-level claim covers every model it lists, which is what "the gateway serves images" means. The editor card stays as it is: a declared route edited there may have gained hand-written per-model `input` fields in the meantime, and a provider-scoped control beside them could only be set to a value some of them reject, the same reason the cards keep reasoning effort out.

**The switch rides the create card's existing write.** It is a field of the one whole-profile `settings.mutate` the card already performs, disabled by the same `profileDisabled` as the other profile fields once the profile write lands, and it gates nothing: vision is a claim about the endpoint, not a precondition of one.

## Alternatives considered

- **A per-model vision checkbox in the model-list editor** — writes each row's own `input`, so one route could mix vision and text-only models from the form. Rejected for the surface it buys: the card's whole flow (fetch available models, hand-typed ids) exists for gateways whose models share one endpoint and one capability set, the per-model rung remains writable in `settings.yaml` for the mixed case, and a checkbox on every row of a thirty-model list is exactly the repetition the route field was introduced to delete.
- **An optimistic `[text, image]` default** — already rejected at the resolver for the severity asymmetry ([route default input modalities](../architecture/2026-08-12-pi-ai-route-default-input-modalities.md)); a form default would be the same choice with less visibility.
- **Expose the switch on the editor card too** — would let a declared route flip its whole route's claim after creation, but only by rewriting `defaultInput` while hand-written per-model `input` fields may sit beside it; the settings document remains the surface for that correction, and the create card is where the claim is made with full knowledge of what is being declared.

## Consequences

A web-only user declares a vision gateway with one checkbox at creation: the profile carries `defaultInput: [text, image]`, every model on the route reports `inputModalities: ['text', 'image']`, and the three admission points plus `read_image` work on it without a line of `settings.yaml`. The stored profile is byte-for-byte what the settings-document remedy produced, so nothing downstream distinguishes the two origins.

The create card now writes a modality claim the user made by checking a box; the resolver's trust model is unchanged — the claim is not verified against the endpoint, and an over-claimed gateway still fails mid-turn after the message is durable. The default-off switch keeps the shipped behavior of every existing flow: a card saved without touching it writes no `defaultInput` at all.

The editor card deliberately stays modality-blind; correcting one model's claim on an existing route is a settings-document edit, as [the route-default note](../architecture/2026-08-12-pi-ai-route-default-input-modalities.md) already decided for `input`.

## Testing

`packages/client/ui-settings-models/tests/provider-form.client.spec.tsx` pins both directions of the switch through the recorded wire write: checked, the create's profile carries `defaultInput: ['text', 'image']` beside the models list; unchecked (the default), the written profile has no `defaultInput` key at all. The card's field-scope case lists the switch among the fields a provider can own, and the resolver-side behavior it feeds is covered where the chain lives, in `packages/llm/llm-pi-ai/tests/catalog.spec.ts`.
