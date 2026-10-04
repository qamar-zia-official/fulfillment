import type { Metadata } from "next";
import { OperationsConsole } from "../../components/operations-console";

export const metadata: Metadata = {
  title: "Exception queue · Kinetous Operations",
  description:
    "Orders that routing could not complete, and everything raised against them.",
};

/**
 *  The exception queue.
 *
 * A thin server component around a client one. The split is not ceremony: the session lives in an
 * HttpOnly cookie that JavaScript cannot read, so the console has to run in the browser, and a
 * page that renders nothing useful on the server should not pretend otherwise.
 */
export default function ExceptionsPage() {
  return <OperationsConsole />;
}
