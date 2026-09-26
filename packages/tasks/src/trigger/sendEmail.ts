import { task } from "@trigger.dev/sdk";

export const sendEmail = task({
  id: "send-email",
  run: async (payload: any, { ctx }) => {},
});
