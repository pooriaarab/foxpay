// The demo popup. It shows the budget, the payments that wait for you, and
// the receipts. The card goes to the background one time, at setup, and the
// fields are cleared. After that the popup sees only summaries.
const send = (type, extra = {}) => browser.runtime.sendMessage({ type, ...extra });
const $ = (id) => document.getElementById(id);
function build(tag, props, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
// USDC is XTS in foxgate: whole atomic units, 6 decimals.
const money = (value, currency) => (currency === "USD" ? `$${(value / 100).toFixed(2)}` : (value / 1e6).toFixed(6));
const label = (currency) => (currency === "XTS" ? "test USDC" : currency);

// Show an answer and count it in data-runs, so a repeated answer is still new.
function answer(output, text) {
  output.textContent = text;
  output.dataset.runs = String(Number(output.dataset.runs ?? 0) + 1);
}
const shown = (r) => (typeof r === "string" ? r : r.status === "refused" || r.status === "error" ? `${r.status}: ${r.reason}` : r.status);

const receipt = (r) => `${r.status}: ${money(r.amount, r.currency)} ${r.currency} to ${r.merchant}, ${r.reason}${r.proof.last4 ? `, card ending ${r.proof.last4}` : ""}${r.proof.transaction ? `, transaction ${r.proof.transaction.slice(0, 10)}…` : ""}${r.failure ? ` (${r.failure})` : ""}`;

async function render() {
  const state = await send("state");
  $("budget").replaceChildren(...state.budget.map((b) => build("li", { textContent: `${label(b.currency)}: cap ${money(b.cap, b.currency)}, spent ${money(b.spent, b.currency)}, left ${money(b.cap - b.spent, b.currency)}` })));
  $("pending").replaceChildren(
    ...state.pending.map(({ requestId, text, intent: i }) => {
      const approve = build("button", { className: "approve", textContent: "Approve" });
      approve.addEventListener("click", async () => {
        const result = await send("approve", { id: i.id, requestId });
        $("approve-body").textContent = result.body ?? "";
        await render();
        answer($("approve-result"), shown(result));
      });
      const reject = build("button", { textContent: "Reject" });
      reject.addEventListener("click", async () => {
        const result = await send("reject", { requestId });
        await render();
        answer($("approve-result"), shown(result));
      });
      const summary = build("div", { className: "summary", textContent: `Pay ${money(i.amount, i.currency)} ${i.currency} to ${i.merchant} for: ${i.reason}` });
      return build("li", {}, [summary, build("pre", { textContent: text }), approve, reject]);
    }),
  );
  $("receipts").replaceChildren(...state.receipts.map((r) => build("li", { textContent: receipt(r) })));
}

$("setup").addEventListener("click", async () => {
  const result = await send("setup", { number: $("card-number").value, exp: $("card-exp").value, cvc: $("card-cvc").value, shopHost: $("shop-host").value, cap: $("shop-cap").value });
  for (const id of ["card-number", "card-exp", "card-cvc"]) $(id).value = "";
  await render();
  answer($("setup-result"), shown(result));
});

$("ask").addEventListener("click", async () => {
  const result = await send("request", { merchant: $("merchant").value, amount: $("amount").value, reason: $("reason").value, key: $("key").value });
  await render();
  answer($("ask-result"), shown(result));
});

$("setup-api").addEventListener("click", async () => {
  const result = await send("setupApi", { walletKey: $("wallet-key").value, apiHost: $("api-host").value, recipient: $("pay-to").value, cap: $("api-cap").value });
  $("wallet-key").value = "";
  await render();
  answer($("setup-api-result"), shown(result));
});

$("call").addEventListener("click", async () => {
  const result = await send("call", { url: $("api-url").value, amount: $("api-amount").value, reason: $("api-reason").value, key: $("api-key").value });
  await render();
  answer($("call-result"), shown(result));
});

render().then(() => {
  document.body.dataset.ready = "1";
});
