// US state license-lookup links. Most states use the NAIC's shared "SBS" public lookup;
// a handful run their own site (overrides below). Steps are generated from the agent's NPN/name.

export const STATE_NAMES = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",
  DE:"Delaware",DC:"District of Columbia",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",
  IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",
  MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",
  NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",
  OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",
  TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",
  WI:"Wisconsin",WY:"Wyoming",
};

const sbs = (code) => `https://sbs.naic.org/solar-external-lookup/?jurisdiction=${code}&searchType=Licensee`;

// States with their own official lookup site instead of the NAIC SBS tool.
const OVERRIDES = {
  MI: { url: "https://difs.state.mi.us/locators?searchtype=InsAgent", kind: "MI" },
  OH: { url: "https://gateway.insurance.ohio.gov/UI/ODI.Agent.Public.UI/AgentSearch.mvc/DisplaySearch", kind: "OH" },
  TX: { url: "https://www.tdi.texas.gov/agent/agent-lookup.html", kind: "NAME" },
  VA: { url: "https://scc.virginia.gov/pages/Agent-Agency-Search", kind: "VA" },
  CO: { url: "https://doi.colorado.gov/for-consumers/consumer-protection", kind: "CO" },
  CA: { url: "https://cdiprod.insurance.ca.gov/LIST/StartupListServlet", kind: "NAME" },
  FL: { url: "https://licenseesearch.fldfs.com/", kind: "NAME" },
  NY: { url: "https://myportal.dfs.ny.gov/nmls/searchNmls", kind: "NAME" },
};

function steps(kind, npn, lastName) {
  const n = npn ? `<b>${npn}</b>` : `my name <b>${lastName}</b>`;
  switch (kind) {
    case "MI": return ["Tap the gold button below.", `Enter ${n}, or my name <b>${lastName}</b>.`, "Tap <b>Search</b>."];
    case "OH": return ["Tap the gold button below.", npn ? `Type ${n} in the <b>National Producer #</b> box.` : `Type <b>${lastName}</b> in the <b>Last Name</b> box.`, "Tap <b>Search</b>."];
    case "VA": return ["Tap the gold button below.", "Open the <b>Producer (Agent/Agency)</b> lookup.", `Search my last name <b>${lastName}</b>.`];
    case "CO": return ["Tap the gold button below.", "Tap the button to check if an agent is licensed.", `Search my last name <b>${lastName}</b>.`];
    case "NAME": return ["Tap the gold button below.", `Search my name: <b>${lastName}</b>.`, "Confirm the result is me, Active, with a Life line."];
    default: return ["Tap the gold button below.", "Check the box <b>I agree to the Terms</b>.", npn ? `Type ${n} in the <b>NPN</b> box and tap <b>Search</b>.` : `Type <b>${lastName}</b> in <b>Last Name</b> and tap <b>Search</b>.`];
  }
}

// Build the per-state data the card needs, for the agent's selected states.
export function statesFor(codes = [], npn = "", fullName = "") {
  const lastName = (fullName || "").trim().split(/\s+/).slice(-1)[0] || fullName || "the agent";
  const out = {};
  for (const raw of codes) {
    const code = String(raw).toUpperCase();
    if (!STATE_NAMES[code]) continue;
    const ov = OVERRIDES[code];
    out[code] = [STATE_NAMES[code], ov ? ov.url : sbs(code), steps(ov ? ov.kind : "SBS", npn, lastName)];
  }
  return out;
}
