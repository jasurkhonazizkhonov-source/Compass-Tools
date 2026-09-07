export type SequenceVariableContext = {
  contactFirstName: string;
  contactLastName: string;
  contactPhone: string;
  contactEmail: string;
  departureCity: string;
  departureAirport: string;
  arrivalCity: string;
  arrivalAirport: string;
  departureDate: string;
  returnDate: string;
  tripType: string;
  cabinClass: string;
  senderFirstName: string;
  senderLastName: string;
  senderPhone: string;
  senderEmail: string;
  companyName: string;
};

export const SEQUENCE_VARIABLES: Array<{ key: keyof SequenceVariableContext; label: string; group: string }> = [
  { key: "contactFirstName", label: "Contact First Name", group: "Customer" },
  { key: "contactLastName", label: "Contact Last Name", group: "Customer" },
  { key: "contactPhone", label: "Contact Phone", group: "Customer" },
  { key: "contactEmail", label: "Contact Email", group: "Customer" },
  { key: "departureCity", label: "Departure City", group: "Travel" },
  { key: "departureAirport", label: "Departure Airport", group: "Travel" },
  { key: "arrivalCity", label: "Arrival City", group: "Travel" },
  { key: "arrivalAirport", label: "Arrival Airport", group: "Travel" },
  { key: "departureDate", label: "Departure Date", group: "Travel" },
  { key: "returnDate", label: "Return Date", group: "Travel" },
  { key: "tripType", label: "Trip Type", group: "Travel" },
  { key: "cabinClass", label: "Cabin Class", group: "Travel" },
  { key: "senderFirstName", label: "Sender First Name", group: "Agent" },
  { key: "senderLastName", label: "Sender Last Name", group: "Agent" },
  { key: "senderPhone", label: "Sender Phone", group: "Agent" },
  { key: "senderEmail", label: "Sender Email", group: "Agent" },
  { key: "companyName", label: "Company Name", group: "Agent" },
];

const CAMEL_TO_SNAKE: Record<string, string> = Object.fromEntries(
  SEQUENCE_VARIABLES.map((v) => [v.key, v.key.replace(/([A-Z])/g, "_$1").toLowerCase()])
);

export function renderSequenceTemplate(template: string, context: SequenceVariableContext): string {
  let output = template;
  for (const v of SEQUENCE_VARIABLES) {
    const token = new RegExp(`{{\\s*${CAMEL_TO_SNAKE[v.key]}\\s*}}`, "gi");
    output = output.replace(token, context[v.key] || "");
  }
  return output;
}

export function variableToken(key: keyof SequenceVariableContext): string {
  return `{{${CAMEL_TO_SNAKE[key]}}}`;
}

const SAMPLE_VALUES: Record<keyof SequenceVariableContext, string> = {
  contactFirstName: "Sarah",
  contactLastName: "Mitchell",
  contactPhone: "(555) 214-7890",
  contactEmail: "sarah.mitchell@example.com",
  departureCity: "New York",
  departureAirport: "JFK",
  arrivalCity: "London",
  arrivalAirport: "LHR",
  departureDate: "Sep 12, 2026",
  returnDate: "Sep 20, 2026",
  tripType: "Round Trip",
  cabinClass: "Business",
  senderFirstName: "Alex",
  senderLastName: "Rivera",
  senderPhone: "(800) 555-0199",
  senderEmail: "alex.rivera@businessflightstravel.com",
  companyName: "Business Flights Travel",
};

/** Keyed by the raw snake_case token name (no braces) for quick lookup while rendering chips. */
export const VARIABLE_TOKEN_META: Record<string, { label: string; group: string; sample: string }> =
  Object.fromEntries(
    SEQUENCE_VARIABLES.map((v) => [
      CAMEL_TO_SNAKE[v.key],
      { label: v.label, group: v.group, sample: SAMPLE_VALUES[v.key] },
    ])
  );
