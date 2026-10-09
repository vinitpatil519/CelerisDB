import type { DocPage } from "./kit";
import { page as p_introduction } from "./pages/introduction";
import { page as p_installation } from "./pages/installation";
import { page as p_quickstart } from "./pages/quickstart";
import { page as p_core_concepts } from "./pages/core-concepts";
import { page as p_playground } from "./pages/playground";
import { page as p_reads_writes } from "./pages/reads-writes";
import { page as p_consistency } from "./pages/consistency";
import { page as p_queries } from "./pages/queries";
import { page as p_change_streams } from "./pages/change-streams";
import { page as p_available_mode } from "./pages/available-mode";
import { page as p_how_it_works } from "./pages/how-it-works";
import { page as p_why_celeris } from "./pages/why-celeris";
import { page as p_sdk_typescript } from "./pages/sdk-typescript";
import { page as p_sdk_python } from "./pages/sdk-python";
import { page as p_sdk_go } from "./pages/sdk-go";
import { page as p_sdk_rust } from "./pages/sdk-rust";
import { page as p_sdk_http } from "./pages/sdk-http";
import { page as p_frameworks } from "./pages/frameworks";
import { page as p_ai } from "./pages/ai";
import { page as p_cloud } from "./pages/cloud";
import { page as p_deployment } from "./pages/deployment";
import { page as p_clustering } from "./pages/clustering";
import { page as p_security } from "./pages/security";
import { page as p_performance } from "./pages/performance";
import { page as p_scaling } from "./pages/scaling";
import { page as p_observability } from "./pages/observability";
import { page as p_backup_restore } from "./pages/backup-restore";
import { page as p_troubleshooting } from "./pages/troubleshooting";
import { page as p_production_checklist } from "./pages/production-checklist";
import { page as p_cli } from "./pages/cli";
import { page as p_http_api } from "./pages/http-api";
import { page as p_errors } from "./pages/errors";
import { page as p_configuration } from "./pages/configuration";
import { page as p_glossary } from "./pages/glossary";

export const GROUPS = ["Get started", "Guides", "Under the hood", "SDKs", "Integrations", "Operate", "Reference"];

const ALL: DocPage[] = [
  p_introduction,
  p_installation,
  p_quickstart,
  p_core_concepts,
  p_playground,
  p_reads_writes,
  p_consistency,
  p_queries,
  p_change_streams,
  p_available_mode,
  p_how_it_works,
  p_why_celeris,
  p_sdk_typescript,
  p_sdk_python,
  p_sdk_go,
  p_sdk_rust,
  p_sdk_http,
  p_frameworks,
  p_ai,
  p_cloud,
  p_deployment,
  p_clustering,
  p_security,
  p_performance,
  p_scaling,
  p_observability,
  p_backup_restore,
  p_troubleshooting,
  p_production_checklist,
  p_cli,
  p_http_api,
  p_errors,
  p_configuration,
  p_glossary,
];

/** Pages in sidebar order: grouped by GROUPS, then in the order listed above. */
export const PAGES: DocPage[] = GROUPS.flatMap((g) => ALL.filter((p) => p.group === g));

export const bySlug = (slug: string): DocPage | undefined => PAGES.find((p) => p.slug === slug);
