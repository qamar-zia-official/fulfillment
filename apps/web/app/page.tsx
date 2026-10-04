import { redirect } from "next/navigation";

/**
 * The root is the queue, and the queue lives at `/exceptions`.
 *
 * A redirect rather than a second page that renders the console: two URLs serving the same
 * console means two links in a browser history and no single address to send a colleague, and
 * "which one is the real one" is a question nobody should have to ask about a triage screen.
 */
export default function Home() {
  redirect("/exceptions");
}
