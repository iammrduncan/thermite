---
title: "FHIR API conformance"
description: "Use a Thermite goal campaign to make a FHIR API pass Inferno's test groups and the HL7 FHIR validator, one goal per test group, checked on synthetic patients the agents never see."
type: use-case
useCase:
  mode: goal
  personas: [startups, enterprises]
  summary: "Agents change the server's FHIR mapping, searches and export. The judge starts the server, runs Inferno's test groups and the HL7 validator, and the run ends when every goal passes twice."
  measure: "Inferno test groups passed · no validator errors, every value from its source record · patients from a seed the agents never see"
sidebar:
  order: 5
---

A health IT product certified under the ONC Health IT Certification Program must offer a standard FHIR API, criterion § 170.315(g)(10): FHIR R4 with US Core 6.1.0 for the data, SMART App Launch 2.0.0 for authorization, and Bulk Data Access for exports of many patients. The Certification Program's Standards Version Advancement Process (SVAP) approves later versions, such as US Core 7.0.0 and 8.0.1. The approved test method is the ONC Certification (g)(10) Standardized API Test Kit, built on Inferno, an open-source test framework that MITRE began in 2018. EHR vendors, health-tech companies and hospital IT teams with a FHIR layer over their own records run Inferno's test kits many times before a testing laboratory does, together with the HL7 FHIR validator, which checks each resource against the profiles it claims.

The work is a long list of small failures: a required search combination missing, `_revinclude=Provenance:target` not supported, a local lab code with no LOINC mapping, an export status endpoint that answers wrongly. Inferno's patient tests pass only when the data shows every Must Support element, which a server must return when it has it, and the criterion's test method says that "Developers will be expected to provide their own data in order to validate testing." The target moves too: the (g)(10) test kit had 11 releases on GitHub in 2026 to 3 November. A server tuned to its sample patients can fail on the next ones. Thermite runs the work as a goal campaign: one goal for each test group, checked by a kit the agents can't see.

## Where Thermite fits

The agents change the server's mapping from your data model to FHIR resources, its search handlers, its CapabilityStatement and its Bulk Data export, each in its own copy. The judge builds each change, starts the server on the rig with a database of synthetic patients, and runs the test client beside it as another user: Inferno's command-line runner on one test group at a time, and the HL7 FHIR validator on every resource the server returns. The agents never see the kit, its patients or the patients held back for the final checks, which come from Synthea, MITRE's synthetic patient generator, with a seed only the kit holds.

## Example campaigns

### 1. US Core 6.1.0 and Bulk Data, group by group

A health-tech company must make its patient API pass the US Core and Bulk Data tests before its certification test.

- **Mode:** a goal campaign. It ends when every required goal passes on two independent checks of the best version, hidden patients included.
- **The goals:**
  - the server builds, starts, loads the kit's patients and answers `GET /metadata`. Every other goal requires it, so they run only once the server starts;
  - the US Core Test Kit's Capability Statement group passes;
  - one goal for each profile group the server must pass: Patient, the two Condition groups, MedicationRequest, and the laboratory Observation and DiagnosticReport groups;
  - the Bulk Data Access Test Kit's group export tests pass;
  - every resource returned validates against US Core 6.1.0 with no errors;
  - every value returned matches the patient's source record: nothing lost, nothing invented.
- **What the agents change:** the mapping code, the search handlers, the export and the CapabilityStatement. The loaders, the database and the tests stay out of their reach.
- **What agents would try:** the `data-absent-reason` extension where the source has no value; the search combinations US Core's server CapabilityStatement requires, such as `patient` with `category` and `date` for Observation; `_include=MedicationRequest:medication`; LOINC mappings for local lab codes; an `$export` that answers `202 Accepted` with a `Content-Location` to poll.
- **What you get:** a branch that passes every goal, with the judge's evidence for each, and the goal report after each promotion.

### 2. Faster Bulk Data exports

A population health platform's nightly group export is too slow for its partners' feeds.

- **Mode:** a hill climb.
- **The number:** patients exported a second on the judge's clock, for a run that starts the server on a prebuilt database of 5,000 Synthea patients and exports them all. Higher is better.
- **What must hold:** the Bulk Data Access Test Kit's group export tests pass, and every NDJSON line validates with no errors.
- **Hidden from the agents:** a population from another seed, exported only at confirmation.
- **What agents would try:** streaming resources to NDJSON instead of building them in memory, one file per resource type written in parallel, queries batched by patient.

### 3. Read the change logs first

Before moving to a later US Core version under SVAP, a research campaign can answer "What changed between US Core 6.1.0 and 8.0.1 that affects a server with these profiles, and what have the test kits changed since?" The agents read US Core's pages on changes between versions, the criterion's test method page and the test kits' release notes, and record claims whose quotes code finds word for word in the pages it archived ([Research](../../explanation/campaign-modes.md#research)).

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "us-core-conformance",
  "version": 1,
  "title": "Pass the US Core 6.1.0 and Bulk Data test groups, with no validator errors",
  "mode": "goal",
  "project": {
    "repo": "patient-api",
    "kit": { "repo": "patient-api-kit", "commit": "8e1f4b2c6a9d3e7f0b5c1a8d4e2f6b9c3a7d5e1f" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "editable_paths": ["src/fhir/**", "src/search/**", "src/export/**", "capability/**"],
  "goals": [
    { "id": "starts", "description": "the server builds, starts, loads the kit's patients and answers GET /metadata", "verify": { "type": "code", "verifier": "starts" } },
    { "id": "capability", "description": "the US Core Test Kit's Capability Statement group passes", "verify": { "type": "code", "verifier": "capability" } },
    { "id": "patient", "description": "the Patient group passes", "verify": { "type": "code", "verifier": "patient" } },
    { "id": "conditions", "description": "the Condition Encounter Diagnosis and Condition Problems and Health Concerns groups pass", "verify": { "type": "code", "verifier": "conditions" } },
    { "id": "medications", "description": "the MedicationRequest group passes", "verify": { "type": "code", "verifier": "medications" } },
    { "id": "labs", "description": "the Observation Laboratory Result and DiagnosticReport for Laboratory Results Reporting groups pass", "verify": { "type": "code", "verifier": "labs" } },
    { "id": "bulk-export", "description": "the Bulk Data Access Test Kit's group export tests pass", "verify": { "type": "code", "verifier": "bulk-export" } },
    { "id": "validator", "description": "every resource returned for the kit's patients validates against US Core 6.1.0 with no errors", "verify": { "type": "code", "verifier": "validator" } },
    { "id": "true-to-source", "description": "every value returned matches the patient's source record: nothing lost, nothing invented", "verify": { "type": "code", "verifier": "fidelity" } }
  ],
  "deliverable": "a branch on which the server meets every required goal",
  "insufficient": ["values the source records don't hold, added to meet Must Support", "responses special-cased for the kit's patients", "search parameters accepted and then ignored"],
  "adversarial_checklist": ["Must Support elements filled with values not in the source record", "searches that return the same results whatever their parameters"],
  "held_out_cells": ["patient-held", "conditions-held", "medications-held", "labs-held", "bulk-held", "validator-held", "fidelity-held"]
}
```

The kit pins releases of the US Core and Bulk Data Access test kits, the validator with its FHIR and US Core packages, and two sets of Synthea patients: one from a seed the team may share, one from a seed only the kit holds. Each cell names an Inferno test group and a set of patients. A run starts the built server and the kit's driver, which loads the patients and runs the group with `inferno execute`. The judge connects a driver to its candidate only through pipes, so a relay of the kit's, beside the server, turns the driver's requests into HTTP calls on the server's local port. Every verifier requires `starts` (priority 1); `capability` has priority 2, the profile groups 10, and `validator` and `fidelity`, the slowest, 50. The others each have a visible cell and a held-out one, such as `patient` and `patient-held`. A group's check reads Inferno's JSON output and prints one line, such as `{"pass": false, "group": "us_core_v610_patient", "tests": 14, "passed": 13, "reasons": ["…"]}`, with `pass` true only when Inferno's result for the group is `pass`; the validator's check prints `{"pass": true, "resources": 1840, "errors": 0, "warnings": 37}` ([Contract](../../reference/contract.md#goal), [Kit manifest](../../reference/kit-manifest.md#verifiers)).

## What to expect

- **Time per check.** Each check starts the server, loads a set of patients and runs one test group or one validation, and after each promotion the judge checks every goal. The validator loads its packages each time it starts, so the kit validates a cell's resources in one call.
- **Where the agents help most.** The long tail: each Must Support element traced from the source schema to its FHIR path, each search combination, each code mapping.
- **Where people stay.** The SMART App Launch scenarios, the visual inspection and attestation steps, clinical review of what each mapping means, and the certification test itself.

## What the judge guards against

The quickest way to pass a conformance test is to answer the test, not the request. Here the server runs as one user and the test client as another, so the server can't write the results the check reads, and the test kits and the validator sit in the kit, outside the editable paths. A server that special-cases the visible patients meets the hidden ones at confirmation: the agents learn which goal failed and how, never which patient. Inferno checks that each Must Support element appears and conforms to its profile, not that it is true, so a mapping could invent values to pass. The `true-to-source` goal compares every value with the source record the kit loaded, and the adversarial checklist sends every promotion to the auditor first.

## Limits

- [Inferno's command-line runner](https://inferno-framework.github.io/docs/getting-started/inferno-cli.html) "does not support SMART launch tests", where a person signs in and approves the app in a browser. Those groups stay in Inferno's web interface, with people; the kit's patient groups run with an access token from the server's test configuration.
- The runner needs Inferno's background services, which Inferno's own set-up starts with Docker. In a kit's driver they run as plain processes, within the run's memory limit (`run.rss_mib`), which a kit with the validator raises.
- The validator checks codes against tx.fhir.org, a public terminology server, unless told otherwise. A check that must answer the same way every time runs it offline and leaves codes to Inferno's terminology files, which the (g)(10) test kit builds from the UMLS with the team's own UMLS account.
- A rig measures on one machine: a server that depends on a hospital's EHR or a cloud identity provider needs a local stand-in.
- Synthea's patients test what Synthea generates. Quirks of real records, such as free-text units and retired local codes, need de-identified samples of your own in the kit.
- Passing the kit's goals is not certification: an ONC-Authorized Testing Laboratory tests the product with the approved test kit, at the versions you certify to.

## Who it's for

- **[Startups](../for/startups.mdx):** health-tech companies preparing a product for (g)(10) certification, or a FHIR API that partners build on.
- **[Enterprises](../for/enterprises.mdx):** EHR vendors and hospital IT teams whose FHIR APIs sit on private data models, on your own machines with a model you host.

## Related work

Inferno's [about page](https://inferno-framework.github.io/about/) says that "MITRE began developing Inferno in 2018 as an open-source testing framework to support the ONC Health IT Certification Program", and that the (g)(10) test kit is "currently used by health IT developers preparing for certification and by Accredited Test Labs (ATLs) conducting conformance evaluations". The criterion's [test method](https://www.healthit.gov/test-method/standardized-api-patient-and-population-services) says that "The test data for this criterion is not provided by ASTP." The (g)(10) test kit's [Single Patient API group](https://github.com/onc-healthit/onc-certification-g10-test-kit/blob/main/lib/onc_certification_g10_test_kit/single_patient_us_core_6_api_group.rb) says that "All MUST SUPPORT elements must be seen before the test can pass". Synthea's [wiki](https://github.com/synthetichealth/synthea/wiki/Basic-Setup-and-Running) says that "Populations generated with the same seed and the same version of Synthea should be identical."

## Get started

1. [Install on one machine](../../tutorials/first-run.md), then [run a first goal campaign](../../tutorials/first-goal-campaign.md) on the sample project.
2. [Choose a campaign mode](../../how-to/campaigns/choose-a-mode.md) says what a goal campaign needs from a kit, and [Write a kit](../../how-to/campaigns/write-a-kit.md#7-add-verifiers-for-goal-campaigns) shows verifiers that require one another.
3. Run the SMART launch groups and the whole (g)(10) test kit in Inferno's web interface before the laboratory does.
