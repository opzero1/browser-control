# Batch browser steps

Default to `act_steps` for every known sequence. A step takes about 0.1 s, but each extra tool call costs a model turn of about 4–5 s. In a September 2026 form-filling benchmark, 31 of 48 `act_steps` calls carried one step. One call can fill a form section, open a menu, select its option, and press **Continue**.

The examples show tool arguments as JSON. Call the tools through your client's prefix for the Browser Control server.

## Choose the batch

Batch every step whose label you know from an observation, a project reference, or an earlier run of the same flow. This includes fills, radios, checkboxes, menu openers, options, and the **Continue** that follows them. Read labels that carry live values, such as balances or counts, from the current page.

End the batch, and use one step or another tool, when:

- the next choice needs judgment about content you have not read, such as a review before submit or a row among results;
- the control has an empty or duplicated label, such as two identical options: use `act` with its observed action ID;
- the control is a file input: use `upload_file` with the observed upload action;
- the field takes a password or OTP: use the private transfer helper;
- the control needs native input: use `cua-driver` under an exclusive lease;
- the state is uncertain after a dispatched stop, a timeout, or `observation_error`: observe first.

Send a submit or another irreversible mutation in its own call, after you inspect the state it commits.

## Chain steps with `expect`

Each step selects its control from the snapshot that the previous step left. Without `expect`, that snapshot is taken right after input and can precede a menu, a filtered option, or the next form step. Put `expect` on the step before such a control; the next step then selects from the matched snapshot.

- Expect a predicate that is false before the step and true after it. Prefer the exact label of the next step's control. `action_label` must match exactly one enabled action, so it also waits for a disabled control, such as **Continue**, to enable.
- Copy labels and text from an observation. `text` is a case-sensitive literal substring. Option labels often include a description: **Pro plan Unlimited projects, priority support**, not **Pro plan**.
- Avoid a label that the step makes ambiguous. After a combobox opens, its trigger and its search input can both read **Search customers**, so that wait fails at once. Expect a label that only the open menu has, such as **Add new customer**.
- Separate same-label controls with `kind` and `role`: the trigger is `click` with role `combobox`, its search input is `fill`, and each item has role `option`.
- A step's wait defaults to 10000 ms; set its `timeout_ms` up to 15000 for a slow submit or drawer. The run budget defaults to 30000 ms; set the run's `timeout_ms` up to 60000 for a long batch.

## Read the result

- `completed` lists the executed steps in order.
- `stopped: null` means every step ran. `final` holds `url`, `title`, `snapshot_id`, coverage flags, and enabled `actions`. With `include_text: true`, it also holds `text` when the last read was full. Read `final` instead of calling `observe`.
- A stop with `dispatched: false` sent nothing for that step, and `final` is still current. Choose from `final.actions`. Resending the remaining steps reuses that snapshot and stops at the same step, so correct the label or `wait_for` the missing control first.
- `reason: "disabled"` means the control is present but disabled, so `final.actions` omits it. Call `wait_for` with `expect: { action_label: label }` until it enables, then resend the remaining steps.
- A stop with `dispatched: true` returns `final: null`. Observe, or use `wait_for` for a transition still in progress, then continue from that state. Never replay a completed step or a submit.
- `final.actions` entries are `"id:label"` strings without kind, role, or disabled controls. Parse one with `entry.slice(entry.indexOf(":") + 1)`. Observe when you need kind or role, such as finding a file input that shares its button's label.

If a menu opener stops with `wait_timeout`, observe. When the option is present, select it from that snapshot. When the menu is closed, open it again from that snapshot; opening a menu changes no data.

## Fill a form section

Fills need no `expect` unless they make something load. Continue the section in the same call.

```json
{
  "tab_id": "isolated-1:896353507",
  "steps": [
    { "label": "First name", "kind": "fill", "text": "Sam" },
    { "label": "Last name", "kind": "fill", "text": "Example" },
    { "label": "Work email", "kind": "fill", "text": "sam@example.com" },
    { "label": "Company name", "kind": "fill", "text": "Example Ltd" },
    { "label": "I agree to the terms", "kind": "click", "role": "checkbox", "expect": { "action_label": "Continue" } },
    { "label": "Continue", "kind": "click", "expect": { "text": "Choose a plan" } }
  ],
  "include_text": true
}
```

## Open a menu and select its option

Put the option's label on the opener's `expect`. On the option step, expect the trigger's new label to confirm the selection before the next menu opens.

```json
{
  "tab_id": "isolated-1:896353507",
  "steps": [
    { "label": "Select a plan", "kind": "click", "expect": { "action_label": "Pro plan Unlimited projects, priority support" } },
    { "label": "Pro plan Unlimited projects, priority support", "kind": "click", "role": "option", "expect": { "action_label": "Pro plan" } },
    { "label": "Select a billing period", "kind": "click", "expect": { "action_label": "Yearly (save 20%)" } },
    { "label": "Yearly (save 20%)", "kind": "click", "role": "option" }
  ],
  "include_text": true
}
```

## Search and select in a combobox

The filtered list renders after the fill, so the fill carries the option's label.

```json
{
  "tab_id": "isolated-1:896353507",
  "steps": [
    { "label": "Search customers", "kind": "click", "role": "combobox", "expect": { "action_label": "Add new customer" } },
    { "label": "Search customers", "kind": "fill", "role": "combobox", "text": "Example Ltd", "expect": { "action_label": "Example Ltd · Account 1001" } },
    { "label": "Example Ltd · Account 1001", "kind": "click", "role": "option" }
  ],
  "include_text": true
}
```

## Submit with a postcondition

Submit in its own call after you inspect the review. `snapshot_id` refuses the call before input if another read replaced the snapshot you inspected. A screenshot does not replace it.

```json
{
  "tab_id": "isolated-1:896353507",
  "snapshot_id": "87ef2561b51942549d59783825032aac",
  "steps": [{ "label": "Place order", "kind": "click", "expect": { "action_label": "View order status" }, "timeout_ms": 15000 }],
  "include_text": true
}
```

Here `snapshot_id` is the `final.snapshot_id` of the inspected review. After a dispatched stop, look for the result before any other mutation. Never submit again.

## Navigate, then act

`navigate` observes once, often before a single-page app renders its controls. Wait for the first control, then batch from the matched snapshot without another observation. In a code-mode client, run the sequence as one script:

```js
const bc = tools["browser-control"]; // your client's prefix for the server
const tab = "isolated-1:896353507"; // claimed tab ID
await bc.navigate({ tab_id: tab, url: "https://app.example.com/orders" });
const ready = await bc.wait_for({ tab_id: tab, expect: { action_label: "New order" }, timeout_ms: 15000 });
if (ready.outcome !== "matched") return ready;
return await bc.act_steps({
	tab_id: tab,
	steps: [
		{ label: "New order", kind: "click", expect: { action_label: "Search customers" }, timeout_ms: 15000 },
		{ label: "Search customers", kind: "click", role: "combobox", expect: { action_label: "Add new customer" } },
	],
});
```

In other clients, make the same three calls in order and stop when `wait_for` returns anything but `outcome: "matched"`. Append the rest of the known sequence to `steps`.

## Avoid these patterns

| Seen in the benchmark | Fix |
| --- | --- |
| One step per `act_steps` call. | Send the whole known sequence in one call. |
| `observe` after each batch: 17 reads in one 30-call run. | Read `final`. Add `include_text: true` when you need text. Observe after a dispatched stop or to read kind and role. |
| A screenshot to check progress. | Use `expect` or `wait_for`. Take a screenshot for a visual claim or cited evidence. |
| Guessed text such as **Amount**, **Fee**, or **Details**. Each wait timed out after 10–15 s. | Copy text or a label from an observation of the destination. |
| A predicate that is already true or fits the wrong page. An `action_label` matched the trigger just clicked, and a `text` matched a list column header. | Expect something absent before the step and unique to the destination, such as the next control's label. |
| **Continue** expected while a required field was still empty. | Expect only what the batch can make true. |
| A search fill followed directly by its option, then the remaining steps resent. Both stopped with `no_match`. | Put `expect: { action_label: option }` on the fill. After such a stop, `wait_for` the option first. |
| `final.actions` read as objects, which produced `undefined:undefined`. | Parse the `"id:label"` strings. |
