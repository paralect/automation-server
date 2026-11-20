import { describe, expect, test } from "bun:test";

import { approvalCard } from "../src/slackBot/approval";
import { parseCard, textCard } from "../src/slackBot/card";

const el = (type: string, props: Record<string, unknown> = {}, children: string[] = []) => ({ type, props, children });

const spec = (elements: Record<string, unknown>, root = "card") => JSON.stringify({ root, elements });

const report = spec({
  card: el("Card", { title: "Отчёт PostHog", subtitle: "13–20 ноября" }, ["totals", "daily", "pages"]),
  totals: el("Fields", {}, ["users", "sessions"]),
  users: el("Field", { label: "Уникальные пользователи", value: "18 (−60.9%)" }),
  sessions: el("Field", { label: "Сессии", value: 24 }),
  daily: el("Chart", { title: "Users per day", chart: { type: "line", categories: ["Nov 19", "Nov 20"], series: [{ name: "This week", values: [3, 5] }] } }),
  pages: el("Table", { caption: "Top pages", headers: ["Page", "Views"], rows: [["/", "8"], ["/ai-slop-remover", "8"]] }),
});

describe("parseCard", () => {
  test("a model spec becomes native Block Kit with a readable fallback text", () => {
    const card = parseCard(report);
    if (!card.ok) throw new Error(card.issues.join("; "));
    expect(card.message.blocks.map((b) => b.type)).toEqual(["header", "context", "section", "data_visualization", "data_table"]);
    expect(card.message.text).toContain("Отчёт PostHog");
    expect(card.message.text).toContain("Сессии: 24");
  });

  test("mrkdwn from the model cannot ping or link, wherever it sits", () => {
    const card = parseCard(
      spec({
        card: el("Card", { title: "<!here> title", subtitle: "<!channel> sub" }, ["text", "fields"]),
        text: el("Text", { content: "*ok* <@U999> <https://evil.test|click> & more" }),
        fields: el("Fields", {}, ["f"]),
        f: el("Field", { label: "<!everyone>", value: "<@U1>" }),
      }),
    );
    if (!card.ok) throw new Error(card.issues.join("; "));
    const json = JSON.stringify(card.message);
    for (const live of ["<!channel>", "<!everyone>", "<@U999>", "<@U1>", "<https://"]) expect(json).not.toContain(live);
    expect(json).toContain("*ok* &lt;@U999&gt; &lt;https://evil.test|click&gt; &amp; more");
    expect(card.message.text).not.toContain("<!channel>");
  });

  test("images, buttons and a card image are not available to the model", () => {
    const withImage = parseCard(spec({ card: el("Card", {}, ["img"]), img: el("Image", { url: "https://evil.test/x.png?d=secret", alt: "x" }) }));
    expect(withImage.ok).toBe(false);
    const withButton = parseCard(spec({ card: el("Card", {}, ["a"]), a: el("Actions", {}, ["b"]), b: el("LinkButton", { label: "go", url: "https://evil.test" }) }));
    expect(withButton.ok).toBe(false);
    const cardImage = parseCard(spec({ card: el("Card", { title: "t", imageUrl: "https://evil.test/x.png" }, ["t"]), t: el("Text", { content: "hi" }) }));
    expect(cardImage.ok && cardImage.message.blocks.map((b) => b.type)).toEqual(["header", "section"]);
  });

  test("what Slack would quietly degrade is rejected with issues the model can fix", () => {
    const chart = (title: string) => el("Chart", { title, chart: { type: "bar", categories: ["a"], series: [{ name: "s", values: [1] }] } });
    const three = parseCard(spec({ card: el("Card", {}, ["a", "b", "c"]), a: chart("a"), b: chart("b"), c: chart("c") }));
    expect(three.ok).toBe(false);
    expect(!three.ok && three.issues.join(" ")).toContain("Chart");

    const tables = parseCard(spec({ card: el("Card", {}, ["a", "b"]), a: el("Table", { headers: ["x"], rows: [["1"]] }), b: el("Table", { headers: ["x"], rows: [["1"]] }) }));
    expect(tables.ok).toBe(false);

    const longLabel = parseCard(spec({ card: el("Card", {}, ["a"]), a: el("Chart", { title: "t", chart: { type: "bar", categories: ["a".repeat(30)], series: [{ name: "s", values: [1] }] } }) }));
    expect(longLabel.ok).toBe(false);

    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`d${i}`, el("Divider")]));
    const tooLong = parseCard(spec({ card: el("Card", {}, Object.keys(many)), ...many }));
    expect(!tooLong.ok && tooLong.issues.join(" ")).toContain("under 50");
  });

  test("broken JSON, a wrong shape and a non-Card root are issues, not exceptions", () => {
    expect(parseCard("{nope")).toEqual({ ok: false, issues: ["specJson is not valid JSON"] });
    expect(parseCard("[1]").ok).toBe(false);
    expect(parseCard(spec({ t: el("Text", { content: "hi" }) }, "t")).ok).toBe(false);
    expect(parseCard(spec({ card: el("Card", {}, ["missing"]) })).ok).toBe(false);
  });
});

describe("textCard", () => {
  test("plain text becomes a one-section card and keeps the text for notifications", () => {
    const card = textCard("Done. *ENG-1* &lt;!channel&gt;");
    expect(card.text).toBe("Done. *ENG-1* &lt;!channel&gt;");
    expect(card.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: "Done. *ENG-1* &lt;!channel&gt;" } }]);
  });

  test("empty text has no blocks, so Slack is not sent an empty section", () => {
    expect(textCard("  ").blocks).toEqual([]);
  });
});

describe("approvalCard", () => {
  test("shows the exact arguments inertly, and the only live markup is the requester mention", () => {
    const card = approvalCard({ tool: "linear.createIssue", args: { title: "**x** <!channel>", body: "```\n*boom*" }, botName: "bot", requestedBy: "U123" });
    expect(card.blocks.map((b) => b.type)).toEqual(["header", "section", "section", "context"]);
    const json = JSON.stringify(card.blocks);
    expect(json).toContain("<@U123>");
    expect(json).not.toContain("<!channel>");
    // Bold conversion would turn **x** into *x*: the arguments must read exactly as they will run.
    expect(json).toContain("*\u200b*x*\u200b*");
    expect(card.text).toContain("I need approval to run `linear.createIssue`");
  });

  test("long arguments are split over several code blocks and none is lost", () => {
    const body = "y".repeat(7000);
    const card = approvalCard({ tool: "t", args: { body }, botName: "b", requestedBy: "U1" });
    const code = card.blocks.filter((b) => b.type === "section" && JSON.stringify(b).includes("```"));
    expect(code.length).toBe(3);
    expect(code.map((b) => JSON.stringify(b).match(/y{2,}/g)!.join("")).join("").length).toBe(7000);
  });
});
