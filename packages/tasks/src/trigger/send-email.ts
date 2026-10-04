import { logger, task } from "@trigger.dev/sdk";

export const sendEmail = task({
  id: "send-email",
  run: async (payload: { messageId: string }) => {
    logger.info("Email delivery task accepted", { messageId: payload.messageId });
    return { accepted: true, messageId: payload.messageId };
  },
});
