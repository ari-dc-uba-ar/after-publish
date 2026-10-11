// @ts-check
/*
 * Espera a que la versión actual de un paquete aparezca publicada en npmjs.
 * Mientras no esté, informa el estado del workflow publish.yml en GitHub Actions.
 *
 * Este módulo no tiene efectos al importarse. La línea de comandos está en bin/after-publish-cli.js.
 *
 * Token de GitHub (opcional, se busca en este orden): GITHUB_TOKEN, GH_TOKEN, `gh auth token`.
 * Mientras falte pushear commits o el tag al remoto, se informa "push pending" y no se consulta nada más.
 * Después, npm se consulta en cada vuelta (cada 5 s). Con token, GitHub también; sin token la API de GitHub
 * permite 60 consultas por hora, por eso se consulta solo 4 veces: a los 5, 15, 25 y 35 s de terminado el push.
 */

import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const execFileAsync = promisify(execFile);

const WORKFLOW_FILE = 'publish.yml';
const TAG_PREFIX = 'v';
const GIT_REMOTE = 'origin';
/** npm se consulta en cada vuelta; con token, GitHub también */
const TICK_MS = 5000;
const GITHUB_FIRST_MS_WITHOUT_TOKEN = 5000;
const GITHUB_INTERVAL_MS_WITHOUT_TOKEN = 10000;
const GITHUB_MAX_QUERIES_WITHOUT_TOKEN = 4;
const TIMEOUT_MS = 20 * 60 * 1000;

/** Resultado de waitForPublish, usado también como código de salida del comando. */
export const EXIT_CODE = Object.freeze({
    published: 0,
    workflowFailed: 1,
    timeout: 2,
    configError: 3,
});

/** Qué significa cada resultado; el CLI lo usa para documentar los códigos de salida en su ayuda. */
/** @type {Readonly<Record<keyof typeof EXIT_CODE, string>>} */
export const EXIT_CODE_DESCRIPTION = Object.freeze({
    published: 'la versión está publicada en npm',
    workflowFailed: 'el workflow terminó sin éxito (failure, cancelled, etc.)',
    timeout: 'se agotó el tiempo de espera',
    configError: 'error de configuración (package.json inválido, repositorio no reconocido, etc.)',
});

const NPM_NAME_PATTERN = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** @typedef {{ name: string, version: string, owner: string, repo: string }} PackageInfo */
/** @typedef {'info' | 'warning'} LogLevel */
/**
 * Recibe cada línea a informar. Las advertencias llegan con level 'warning' para que quien muestre
 * la salida pueda destacarlas (por ejemplo, con color); por omisión se informan como cualquier línea.
 * @typedef {(line: string, level?: LogLevel) => void} LogFunction
 */
/** @typedef {{ id: number, status: string, conclusion: string | null, htmlUrl: string, headBranch: string | null }} RunInfo */

/** @type {Record<string, string>} */
const STATUS_TEXT = {
    requested: 'solicitado',
    queued: 'en cola',
    pending: 'pendiente',
    waiting: 'esperando aprobación',
    in_progress: 'corriendo',
};

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} err
 * @returns {string}
 */
export function describeError(err) {
    return err instanceof Error ? err.message : String(err);
}

/**
 * @param {string} url
 * @returns {{ owner: string, repo: string } | null}
 */
export function parseGithubRepo(url) {
    const match = /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(url)
        ?? /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?(?:#.*)?$/.exec(url);
    if (match == null) return null;
    const [, owner, repo] = match;
    return { owner, repo };
}

/**
 * @param {string} dir
 * @returns {Promise<string>}
 */
async function readPackageJsonText(dir) {
    try {
        return await readFile(join(dir, 'package.json'), 'utf8');
    } catch (err) {
        if (isRecord(err) && err.code === 'ENOENT') {
            throw new Error(`No hay package.json en ${dir.replaceAll('\\', '/')}`);
        }
        throw err;
    }
}

/**
 * @param {string} dir
 * @returns {Promise<PackageInfo>}
 */
export async function readPackageInfo(dir) {
    /** @type {unknown} */
    const pkg = JSON.parse(await readPackageJsonText(dir));
    if (!isRecord(pkg)) throw new Error('package.json no contiene un objeto');
    const { name, version, repository } = pkg;
    if (typeof name !== 'string' || !NPM_NAME_PATTERN.test(name)) throw new Error('package.json: "name" ausente o inválido');
    if (typeof version !== 'string' || version === '') throw new Error('package.json: "version" ausente');
    /** @type {string | null} */
    const repositoryUrl = typeof repository === 'string' ? repository
        : isRecord(repository) && typeof repository.url === 'string' ? repository.url
        : null;
    if (repositoryUrl == null) throw new Error('package.json: falta "repository"');
    const githubRepo = parseGithubRepo(repositoryUrl);
    if (githubRepo == null) throw new Error(`package.json: "repository" no es de GitHub (${repositoryUrl})`);
    return { name, version, ...githubRepo };
}

/** @returns {Promise<string | null>} */
async function getGithubToken() {
    const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (fromEnv) return fromEnv;
    try {
        const { stdout } = await execFileAsync('gh', ['auth', 'token']);
        const token = stdout.trim();
        return token === '' ? null : token;
    } catch {
        return null;
    }
}

/**
 * @param {string} dir
 * @param {string[]} args
 * @returns {Promise<string | null>} la salida sin espacios al final, o null si git falla
 */
async function gitOutput(dir, args) {
    try {
        const { stdout } = await execFileAsync('git', args, { cwd: dir });
        return stdout.trim();
    } catch {
        return null;
    }
}

/**
 * @param {string} dir
 * @param {string} tag
 * @returns {Promise<string | null>}
 */
async function getTagCommit(dir, tag) {
    const sha = await gitOutput(dir, ['rev-list', '-n', '1', tag, '--']);
    return sha != null && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * Indica si hay archivos versionados con cambios sin commitear (no cuenta los archivos nuevos sin agregar).
 * Si no se puede averiguar (por ejemplo, no es un repositorio git), no los da por existentes.
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
export async function hasUncommittedChanges(dir) {
    const status = await gitOutput(dir, ['status', '--porcelain', '--untracked-files=no']);
    return status != null && status !== '';
}

/**
 * Indica si falta pushear: commits de la rama actual que su upstream no tiene, o el tag que el remoto no tiene.
 * Si no se puede averiguar (sin upstream, sin remoto, sin red), no lo da por pendiente.
 * @param {string} dir
 * @param {string} tag
 * @returns {Promise<boolean>}
 */
export async function isPushPending(dir, tag) {
    const ahead = await gitOutput(dir, ['rev-list', '--count', '@{u}..HEAD']);
    if (ahead != null && Number.parseInt(ahead, 10) > 0) return true;
    const localTag = await gitOutput(dir, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
    if (localTag == null || localTag === '') return false;
    const remoteTag = await gitOutput(dir, ['ls-remote', '--tags', GIT_REMOTE, `refs/tags/${tag}`]);
    return remoteTag === '';
}

/**
 * @param {string} url
 * @param {string} accept
 * @returns {Promise<unknown | null>} null si el registry responde 404
 */
async function fetchRegistry(url, accept) {
    // la CDN del registry ignora "cache-control: no-cache" y responde copias de hasta 5 minutos;
    // un parámetro distinto en cada consulta obliga a pedirla al registry
    const res = await fetch(`${url}?t=${Date.now()}`, { headers: { accept } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`registry respondió ${res.status}`);
    /** @type {unknown} */
    const data = await res.json();
    return data;
}

/**
 * Estado de una versión en npm:
 * - published: figura en el documento del paquete, que es lo que usa `npm install`.
 * - validating: el registry ya tiene el documento de la versión, pero todavía no la lista
 *   (en npmjs.com figura como "Validating": la revisión automática no terminó).
 * - absent: el registry no la conoce.
 * @param {string} name
 * @param {string} version
 * @returns {Promise<'published' | 'validating' | 'absent'>}
 */
export async function getNpmVersionStatus(name, version) {
    const base = `https://registry.npmjs.org/${name.replace('/', '%2F')}`;
    const packument = await fetchRegistry(base, 'application/vnd.npm.install-v1+json');
    if (isRecord(packument) && isRecord(packument.versions) && version in packument.versions) return 'published';
    const versionDocument = await fetchRegistry(`${base}/${encodeURIComponent(version)}`, 'application/json');
    return versionDocument == null ? 'absent' : 'validating';
}

/**
 * @param {unknown} run
 * @returns {RunInfo | null}
 */
function parseRun(run) {
    if (!isRecord(run)) return null;
    const { id, status, conclusion, html_url: htmlUrl, head_branch: headBranch } = run;
    if (typeof id !== 'number' || typeof status !== 'string' || typeof htmlUrl !== 'string') return null;
    return {
        id,
        status,
        conclusion: typeof conclusion === 'string' ? conclusion : null,
        htmlUrl,
        headBranch: typeof headBranch === 'string' ? headBranch : null,
    };
}

/**
 * Devuelve la ejecución más reciente del workflow para el commit del tag
 * (o, si no se conoce el commit, para la rama/tag con ese nombre).
 * @param {PackageInfo} info
 * @param {string} tag
 * @param {string | null} sha
 * @param {string | null} token
 * @returns {Promise<RunInfo | null>}
 */
export async function getWorkflowRun(info, tag, sha, token) {
    const params = new URLSearchParams({ per_page: '10' });
    if (sha != null) params.set('head_sha', sha);
    const data = await githubGet(info, `/actions/workflows/${encodeURIComponent(WORKFLOW_FILE)}/runs?${params}`, token);
    if (data == null) throw new Error(`no se encontró ${WORKFLOW_FILE} en ${info.owner}/${info.repo}`);
    for (const rawRun of recordArray(data, 'workflow_runs')) {
        const run = parseRun(rawRun);
        if (run != null && (sha != null || run.headBranch === tag)) return run;
    }
    return null;
}

/**
 * @param {PackageInfo} info
 * @param {string} path ruta dentro del repositorio, empezando con /
 * @param {string | null} token
 * @returns {Promise<unknown | null>} null si GitHub responde 404
 */
async function githubGet(info, path, token) {
    const url = `https://api.github.com/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}${path}`;
    /** @type {Record<string, string>} */
    const headers = {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'after-publish',
    };
    if (token != null) headers.authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub respondió ${res.status}`);
    /** @type {unknown} */
    const data = await res.json();
    return data;
}

/**
 * Devuelve el arreglo `data[key]`, o lanza un error si la respuesta no tiene esa forma.
 * @param {unknown} data
 * @param {string} key
 * @returns {unknown[]}
 */
function recordArray(data, key) {
    if (!isRecord(data)) throw new Error('respuesta inesperada de GitHub');
    /** @type {unknown} */
    const value = data[key];
    if (!Array.isArray(value)) throw new Error('respuesta inesperada de GitHub');
    /** @type {unknown[]} */
    const items = value;
    return items;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>[]}
 */
function onlyRecords(value) {
    return Array.isArray(value) ? value.filter(isRecord) : [];
}

const ACTIVE_JOB_STATUSES = ['in_progress'];
const WAITING_JOB_STATUSES = ['queued', 'waiting', 'pending', 'requested'];

/**
 * Describe en qué está una ejecución que no terminó: el job que está corriendo y su paso en curso,
 * o, si ninguno corre, el job que espera runner. Devuelve null si no hay nada que agregar.
 * @param {PackageInfo} info
 * @param {number} runId
 * @param {string | null} token
 * @returns {Promise<string | null>}
 */
export async function getRunProgress(info, runId, token) {
    const jobs = onlyRecords(recordArray(await githubGet(info, `/actions/runs/${runId}/jobs?per_page=100`, token), 'jobs'));
    const running = jobs.find((job) => typeof job.status === 'string' && ACTIVE_JOB_STATUSES.includes(job.status));
    if (running != null) {
        const step = onlyRecords(running.steps)
            .find((candidate) => typeof candidate.status === 'string' && ACTIVE_JOB_STATUSES.includes(candidate.status));
        return `job "${jobName(running)}"` + (step != null && typeof step.name === 'string' ? `, paso "${step.name}"` : '');
    }
    const waiting = jobs.find((job) => typeof job.status === 'string' && WAITING_JOB_STATUSES.includes(job.status));
    return waiting != null ? `job "${jobName(waiting)}" esperando runner` : null;
}

/**
 * @param {Record<string, unknown>} job
 * @returns {string}
 */
function jobName(job) {
    return typeof job.name === 'string' ? job.name : 'sin nombre';
}

const FAILED_CONCLUSIONS = ['failure', 'timed_out', 'cancelled', 'startup_failure'];
const MAX_ANNOTATIONS_PER_JOB = 5;

/**
 * Describe por qué falló una ejecución: cada job fallido con sus pasos fallidos,
 * y los mensajes de error que GitHub dejó como anotaciones de ese job.
 * @param {PackageInfo} info
 * @param {number} runId
 * @param {string | null} token
 * @returns {Promise<string[]>} una línea por dato
 */
export async function getRunFailureDetails(info, runId, token) {
    /** @type {string[]} */
    const lines = [];
    const jobs = await githubGet(info, `/actions/runs/${runId}/jobs?per_page=100`, token);
    for (const job of onlyRecords(recordArray(jobs, 'jobs'))) {
        if (typeof job.conclusion !== 'string' || !FAILED_CONCLUSIONS.includes(job.conclusion)) continue;
        const failedSteps = onlyRecords(job.steps)
            .filter((step) => typeof step.conclusion === 'string' && FAILED_CONCLUSIONS.includes(step.conclusion))
            .map((step) => (typeof step.name === 'string' ? `"${step.name}"` : 'sin nombre'));
        lines.push(`job "${jobName(job)}": ${job.conclusion}`
            + (failedSteps.length > 0 ? `, paso ${failedSteps.join(', ')}` : ''));
        if (typeof job.id !== 'number') continue;
        const annotations = await githubGet(info, `/check-runs/${job.id}/annotations`, token);
        onlyRecords(annotations)
            .filter((annotation) => annotation.annotation_level === 'failure' && typeof annotation.message === 'string')
            .slice(0, MAX_ANNOTATIONS_PER_JOB)
            .forEach((annotation) => { lines.push(`error: ${String(annotation.message).trim()}`); });
    }
    return lines;
}

/**
 * @param {number} ms
 * @returns {string}
 */
function formatElapsed(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
}

/**
 * @param {RunInfo} run
 * @returns {string}
 */
function describeRun(run) {
    if (run.status !== 'completed') return STATUS_TEXT[run.status] ?? run.status;
    if (run.conclusion === 'success') return 'terminó bien';
    return `terminó: ${run.conclusion ?? 'sin conclusión'}`;
}

/**
 * @typedef {{
 *   info: PackageInfo,
 *   dir: string,
 *   log: LogFunction,
 *   tag: string,
 *   sha: string | null,
 *   uncommitted: boolean,
 *   token: string | null,
 *   githubFirstTick: number,
 *   githubEveryTicks: number,
 *   githubMaxQueries: number | null,
 *   start: number,
 *   shownRunUrl: string | null,
 *   githubQueries: number,
 *   npmValidating: boolean,
 *   workflowDone: boolean,
 *   pushedAtTick: number | null,
 * }} WatchState
 */

/**
 * @param {string} dir
 * @param {LogFunction} log
 * @returns {Promise<WatchState>}
 */
async function prepareWatch(dir, log) {
    const info = await readPackageInfo(dir);
    const tag = `${TAG_PREFIX}${info.version}`;
    const token = await getGithubToken();
    const sha = await getTagCommit(dir, tag);
    const uncommitted = await hasUncommittedChanges(dir);
    return {
        info,
        dir,
        log,
        tag,
        sha,
        uncommitted,
        token,
        githubFirstTick: token != null ? 0 : GITHUB_FIRST_MS_WITHOUT_TOKEN / TICK_MS,
        githubEveryTicks: token != null ? 1 : GITHUB_INTERVAL_MS_WITHOUT_TOKEN / TICK_MS,
        githubMaxQueries: token != null ? null : GITHUB_MAX_QUERIES_WITHOUT_TOKEN,
        start: Date.now(),
        shownRunUrl: null,
        githubQueries: 0,
        npmValidating: false,
        workflowDone: false,
        pushedAtTick: null,
    };
}

/**
 * @param {WatchState} state
 * @returns {void}
 */
function printHeader(state) {
    const { info, tag, sha, uncommitted, token, log } = state;
    log(`Esperando ${info.name}@${info.version} — ${info.owner}/${info.repo}, tag ${tag}`
        + (sha != null ? ` (${sha.slice(0, 7)})` : ' (tag no encontrado localmente)'));
    if (uncommitted) log(`uncommitted: hay cambios sin commitear (no forman parte de ${tag})`, 'warning');
    if (token == null) {
        log(`Sin token de GitHub: ${WORKFLOW_FILE} se consulta ${GITHUB_MAX_QUERIES_WITHOUT_TOKEN} veces, `
            + `cada ${GITHUB_INTERVAL_MS_WITHOUT_TOKEN / 1000} s a partir de los ${GITHUB_FIRST_MS_WITHOUT_TOKEN / 1000} s de terminado el push.`
            + ' Para más detalle, definí GITHUB_TOKEN o usá `gh auth login`.', 'warning');
    }
}

/** @type {Record<'published' | 'validating' | 'absent', string>} */
const NPM_STATUS_TEXT = {
    published: 'publicado',
    validating: 'validando (revisión automática de npm)',
    absent: 'no publicado',
};

/**
 * @param {PackageInfo} info
 * @returns {Promise<{ status: 'published' | 'validating' | 'absent' | 'error', text: string }>}
 */
async function checkNpm(info) {
    try {
        const status = await getNpmVersionStatus(info.name, info.version);
        return { status, text: NPM_STATUS_TEXT[status] };
    } catch (err) {
        return { status: 'error', text: `error (${describeError(err)})` };
    }
}

/**
 * @param {WatchState} state
 * @param {number} tick
 * @returns {boolean}
 */
function shouldQueryGithub(state, tick) {
    // si npm ya la está validando, el workflow ya publicó: no hace falta seguir mirándolo
    if (state.npmValidating) return false;
    // si el workflow ya terminó bien, solo falta esperar a npm
    if (state.workflowDone) return false;
    const queriesLeft = state.githubMaxQueries == null || state.githubQueries < state.githubMaxQueries;
    if (state.pushedAtTick == null) return false;
    const sinceFirst = tick - state.pushedAtTick - state.githubFirstTick;
    return sinceFirst >= 0 && sinceFirst % state.githubEveryTicks === 0 && queriesLeft;
}

/**
 * Consulta el workflow y devuelve el texto a informar, si terminó y si terminó sin éxito.
 * @param {WatchState} state
 * @param {string} elapsed
 * @returns {Promise<{ text: string, done: boolean, failed: boolean, details: string[] }>}
 */
async function checkWorkflow(state, elapsed) {
    state.githubQueries++;
    try {
        const run = await getWorkflowRun(state.info, state.tag, state.sha, state.token);
        if (run == null) return { text: 'todavía sin ejecución', done: false, failed: false, details: [] };
        if (run.htmlUrl !== state.shownRunUrl) {
            state.log(`${elapsed} ejecución: ${run.htmlUrl}`);
            state.shownRunUrl = run.htmlUrl;
        }
        const done = run.status === 'completed';
        const failed = done && run.conclusion !== 'success';
        const details = failed ? await describeFailure(state, run) : [];
        const progress = done ? null : await describeProgress(state, run);
        return { text: describeRun(run) + (progress != null ? ` — ${progress}` : ''), done, failed, details };
    } catch (err) {
        return { text: `error (${describeError(err)})`, done: false, failed: false, details: [] };
    }
}

/**
 * Job y paso en curso. Solo con token: sin token las consultas a GitHub son pocas y se reservan para el estado.
 * Si no se puede obtener, devuelve null y se informa solo el estado de la ejecución.
 * @param {WatchState} state
 * @param {RunInfo} run
 * @returns {Promise<string | null>}
 */
async function describeProgress(state, run) {
    if (state.token == null) return null;
    try {
        return await getRunProgress(state.info, run.id, state.token);
    } catch {
        return null;
    }
}

/**
 * @param {WatchState} state
 * @param {RunInfo} run
 * @returns {Promise<string[]>}
 */
async function describeFailure(state, run) {
    /** @type {string[]} */
    let details;
    try {
        details = await getRunFailureDetails(state.info, run.id, state.token);
    } catch (err) {
        details = [`no se pudo obtener el detalle (${describeError(err)})`];
    }
    return [...details, `ver: ${run.htmlUrl}`];
}

/**
 * Ejecuta una vuelta del ciclo e informa una línea con lo consultado en ella.
 * Si se consultó el workflow, la línea informa su estado: que npm no la tiene se sobrentiende
 * (si la tuviera, ya se habría terminado, y si la estuviera validando, no se consultaría el workflow).
 * Devuelve el código de salida si hay que terminar, o null para seguir.
 * @param {WatchState} state
 * @param {number} tick
 * @returns {Promise<number | null>}
 */
async function watchTick(state, tick) {
    const elapsed = formatElapsed(Date.now() - state.start);
    if (state.pushedAtTick == null) {
        await refreshVersion(state, elapsed);
        if (await isPushPending(state.dir, state.tag)) {
            state.log(`${elapsed} push pending`);
            return checkTimeout(state);
        }
        state.pushedAtTick = tick;
    }
    const npm = await checkNpm(state.info);
    if (npm.status === 'validating') state.npmValidating = true;
    if (npm.status === 'published') {
        state.log(`${elapsed} publicado en npm: ${state.info.name}@${state.info.version}`);
        return EXIT_CODE.published;
    }
    const npmLine = `${elapsed} npm: ${npm.text}`;
    let failed = false;
    if (shouldQueryGithub(state, tick)) {
        const workflow = await checkWorkflow(state, elapsed);
        const workflowText = `${WORKFLOW_FILE}: ${workflow.text}`;
        state.log(npm.status === 'error' ? `${npmLine} | ${workflowText}` : `${elapsed} ${workflowText}`);
        workflow.details.forEach((detail) => { state.log(`      ${detail}`); });
        state.workflowDone = workflow.done;
        failed = workflow.failed;
    } else {
        state.log(npmLine);
    }
    if (failed) return EXIT_CODE.workflowFailed;
    return checkTimeout(state);
}

/**
 * Mientras falta el push, la versión puede cambiar (por ejemplo, con un `npm version` hecho durante la espera):
 * vuelve a leer el package.json y, si cambió, pasa a esperar la versión nueva.
 * Si el package.json no se puede leer en este momento (por ejemplo, se está escribiendo), sigue con la anterior.
 * @param {WatchState} state
 * @param {string} elapsed
 * @returns {Promise<void>}
 */
async function refreshVersion(state, elapsed) {
    /** @type {PackageInfo} */
    let info;
    try {
        info = await readPackageInfo(state.dir);
    } catch {
        return;
    }
    if (info.name === state.info.name && info.version === state.info.version) return;
    state.info = info;
    state.tag = `${TAG_PREFIX}${info.version}`;
    state.sha = await getTagCommit(state.dir, state.tag);
    state.log(`${elapsed} versión cambiada: ahora espera ${info.name}@${info.version}, tag ${state.tag}`
        + (state.sha != null ? ` (${state.sha.slice(0, 7)})` : ' (tag no encontrado localmente)'));
}

/**
 * @param {WatchState} state
 * @returns {number | null} EXIT_CODE.timeout si se agotó el tiempo de espera, o null para seguir
 */
function checkTimeout(state) {
    if (Date.now() - state.start <= TIMEOUT_MS) return null;
    state.log(`Se agotó el tiempo de espera (${TIMEOUT_MS / 60000} min).`);
    return EXIT_CODE.timeout;
}

/**
 * @typedef {{
 *   dir: string,
 *   log: LogFunction,
 * }} WaitForPublishOptions
 * dir: carpeta del paquete (la que tiene el package.json); log: recibe cada línea a informar.
 */

/**
 * Espera a que la versión del package.json de `options.dir` esté publicada en npm, informando una línea por cada consulta (cada 5 s).
 * Devuelve EXIT_CODE.published, EXIT_CODE.workflowFailed o EXIT_CODE.timeout.
 * Si el package.json no es válido o el repositorio no es de GitHub, lanza un error.
 * @param {WaitForPublishOptions} options
 * @returns {Promise<number>}
 */
export async function waitForPublish(options) {
    const state = await prepareWatch(resolve(options.dir), options.log);
    printHeader(state);
    for (let tick = 0; ; tick++) {
        const tickStart = Date.now();
        const exitCode = await watchTick(state, tick);
        if (exitCode != null) return exitCode;
        await sleep(Math.max(0, TICK_MS - (Date.now() - tickStart)));
    }
}
