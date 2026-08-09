import type { FleetMember, PanelVote } from "./types.ts";
import { formatBallots } from "./jury.ts";

export function collaborationSystem(
  member: FleetMember,
  lead: FleetMember,
  participants: FleetMember[],
) {
  const roster = participants
    .map(
      (item) =>
        `${item.id}${item.id === lead.id ? " (LEAD)" : ""}: ${item.role} · ${item.model.providerID}/${item.model.modelID}`,
    )
    .join("\n");
  return [
    member.system,
    `You are fleet member **${member.id}** with role **${member.role}**.`,
    member.id === lead.id
      ? "You are LEAD. You own assignments and the final answer unless this mode explicitly uses round-robin output."
      : `LEAD is **${lead.id}**. Return concrete findings to the lead; do not pretend to be the lead.`,
    `Active fleet:\n${roster}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function jurorPrompt(input: {
  question: string;
  juror: FleetMember;
  lead: FleetMember;
  participants: FleetMember[];
  round: 1 | 2;
  peerBallots?: string;
}) {
  return [
    `Question:\n${input.question}`,
    `You are independent juror **${input.juror.id}**. Judge **${input.lead.id}** will decide.`,
    input.round === 1
      ? "Form your view independently. Do not assume another juror's position."
      : `Reconsider after reading the first-round ballots. Keep or revise your vote and directly address the strongest disagreement.\n\n${input.peerBallots ?? ""}`,
    "Return exactly these labeled sections:",
    "POSITION: <one-sentence position>",
    "VOTE: <approve|reject|conditional|abstain>",
    "CONFIDENCE: <high|medium|low>",
    "RATIONALE: <reasoning>",
    "RISKS: <main risks>",
    "ALTERNATIVE: <best alternative>",
  ].join("\n\n");
}

export function judgePrompt(
  question: string,
  lead: FleetMember,
  votes: PanelVote[],
  majority: string,
) {
  return [
    `Question:\n${question}`,
    `You are judge and LEAD **${lead.id}**. Decide from evidence; majority=${majority} is advisory, not binding.`,
    `Juror ballots:\n${formatBallots(votes)}`,
    "Return the final decision for the user. State the decision, reasoning, important dissent, risks, and next action.",
  ].join("\n\n");
}
