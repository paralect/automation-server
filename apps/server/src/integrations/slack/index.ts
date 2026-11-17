import { postToSlack } from "@automation-server/automations";

import { defineModule } from "../module";

export const slack = defineModule({
  id: "slack",
  build: () => ({}),
  async test({ slack }, { fetch }) {
    if (!slack.configured) return { ok: false, available: true, message: "Slack webhook URL is not set" };
    await postToSlack(slack.values.webhookUrl, "Automation server alerts are connected", { fetch });
    const where = slack.values.channelLabel ? ` ${slack.values.channelLabel}` : "";
    return { ok: true, available: true, message: `Test message sent to Slack${where}` };
  },
});
