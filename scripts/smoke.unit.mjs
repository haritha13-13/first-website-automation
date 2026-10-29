import { saveWorkflow, findWorkflow, isValidWorkflow, deleteWorkflow, listWorkflows } from "../src/workflow/repository.js";
import { recordSubmission, listSubmissions, summary } from "../src/storage/submissionStore.js";

let fails = 0;
const check = (name, cond) => {
  console.log(` ${cond ? "ok " : "FAIL"} ${name}`);
  if (!cond) fails++;
};

console.log("--- repository ---");
const url = "https://example.test/";
const wf = {
  meta: { siteName: "Example", siteUrl: url },
  auth: { required: false, loginSteps: [] },
  steps: [{ id: "s1", action: "goto", url }],
  fieldMappings: {},
  status: "complete",
};
saveWorkflow(url, wf);
const found = findWorkflow(url);
check("save+find round trip", !!found && found.workflow.steps[0].action === "goto");
check("isValidWorkflow(true)", isValidWorkflow(found.workflow) === true);
check("isValidWorkflow(bad)", isValidWorkflow({ steps: [{ id: "x", action: "bogus" }] }) === false);

console.log("--- storage ---");
const rec = recordSubmission({
  site: "Example",
  siteUrl: url,
  title: "Hello",
  category: "C",
  tags: ["a"],
  visibility: "public",
  backlinkUrl: "https://target.example",
  status: "published",
  publishedUrl: "https://example.test/gallery/1",
  workflowUsed: "repository",
});
check("record has id", !!rec.id && rec.id.startsWith("sub-"));
check("record status", rec.status === "published");
check("listing contains record", listSubmissions().some((s) => s.id === rec.id));
const s = summary();
check("summary total >= 1", s.total >= 1);
check("summary published >= 1", s.published >= 1);

deleteWorkflow(url);
check("workflow deleted", findWorkflow(url) === null);

console.log(fails ? `\n${fails} FAILURES` : "\nALL UNIT CHECKS PASSED");
process.exit(fails ? 1 : 0);