#!/usr/bin/env node
// @ts-check
/*
 * Espera a que la versión actual de un paquete aparezca publicada en npmjs.
 * Mientras no esté, informa el estado del workflow publish.yml en GitHub Actions.
 *
 * Uso: node esperar-publicacion.mjs [carpeta-del-paquete]
 *
 * Códigos de salida:
 *   0 publicado en npm
 *   1 el workflow terminó sin éxito (failure, cancelled, etc.)
 *   2 se agotó el tiempo de espera
 *   3 error de configuración (package.json inválido, repositorio no reconocido, etc.)
 *
 * Token de GitHub (opcional, se busca en este orden): GITHUB_TOKEN, GH_TOKEN, `gh auth token`.
 * Sin token la API de GitHub permite 60 consultas por hora, por eso se consulta mucho menos seguido.
 */

import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const execFileAsync = promisify(execFile);

const WORKFLOW_FILE = 'publish.yml';
const TAG_PREFIX = 'v';
const TICK_MS = 1000;
const GITHUB_EVERY_TICKS_WITH_TOKEN = 3;
const GITHUB_EVERY_TICKS_WITHOUT_TOKEN = 5;
const GITHUB_MAX_QUERIES_WITHOUT_TOKEN = 4;
const TIMEOUT_MS = 20 * 60 * 1000;

const NPM_NAME_PATTERN = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** @typedef {{ name: string, version: string, owner: string, repo: string }} PackageInfo */
/** @typedef {{ status: string, conclusion: string | null, htmlUrl: string, headBranch: string | null }} RunInfo */

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
function describeError(err) {
    return err instanceof Error ? err.message : String(err);
}

/**
 * @param {string} url
 * @returns {{ owner: string, repo: string } | null}
 */
function parseGithubRepo(url) {
    const match = /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(url)
        ?? /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?(?:#.*)?$/.exec(url);
    if (match == null) return null;
    const [, owner, repo] = match;
    return { owner, repo };
}

/**
 * @param {string} dir
 * @returns {Promise<PackageInfo>}
 */
async function readPackageInfo(dir) {
    /** @type {unknown} */
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
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
 * @param {string} tag
 * @returns {Promise<string | null>}
 */
async function getTagCommit(dir, tag) {
    try {
        const { stdout } = await execFileAsync('git', ['rev-list', '-n', '1', tag, '--'], { cwd: dir });
        const sha = stdout.trim();
        return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    } catch {
        return null;
    }
}

/**
 * @param {string} name
 * @param {string} version
 * @returns {Promise<boolean>}
 */
async function isPublishedOnNpm(name, version) {
    const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}/${encodeURIComponent(version)}`;
    const res = await fetch(url, { headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`registry respondió ${res.status}`);
    return true;
}

/**
 * @param {unknown} run
 * @returns {RunInfo | null}
 */
function parseRun(run) {
    if (!isRecord(run)) return null;
    const { status, conclusion, html_url: htmlUrl, head_branch: headBranch } = run;
    if (typeof status !== 'string' || typeof htmlUrl !== 'string') return null;
    return {
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
async function getWorkflowRun(info, tag, sha, token) {
    const params = new URLSearchParams({ per_page: '10' });
    if (sha != null) params.set('head_sha', sha);
    const url = `https://api.github.com/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}`
        + `/actions/workflows/${encodeURIComponent(WORKFLOW_FILE)}/runs?${params}`;
    /** @type {Record<string, string>} */
    const headers = {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'esperar-publicacion',
    };
    if (token != null) headers.authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers });
    if (res.status === 404) throw new Error(`no se encontró ${WORKFLOW_FILE} en ${info.owner}/${info.repo}`);
    if (!res.ok) throw new Error(`GitHub respondió ${res.status}`);
    /** @type {unknown} */
    const data = await res.json();
    if (!isRecord(data)) throw new Error('respuesta inesperada de GitHub');
    /** @type {unknown} */
    const rawRuns = data.workflow_runs;
    if (!Array.isArray(rawRuns)) throw new Error('respuesta inesperada de GitHub');
    /** @type {unknown[]} */
    const runs = rawRuns;
    for (const rawRun of runs) {
        const run = parseRun(rawRun);
        if (run != null && (sha != null || run.headBranch === tag)) return run;
    }
    return null;
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
    if (run.conclusion === 'success') return 'terminó bien (esperando que npm lo muestre)';
    return `terminó: ${run.conclusion ?? 'sin conclusión'}`;
}

/**
 * @typedef {{
 *   info: PackageInfo,
 *   tag: string,
 *   sha: string | null,
 *   token: string | null,
 *   githubEveryTicks: number,
 *   githubMaxQueries: number | null,
 *   start: number,
 *   actionText: string,
 *   shownRunUrl: string | null,
 *   githubQueries: number,
 * }} WatchState
 */

/**
 * @param {string} dir
 * @returns {Promise<WatchState>}
 */
async function prepareWatch(dir) {
    const info = await readPackageInfo(dir);
    const tag = `${TAG_PREFIX}${info.version}`;
    const token = await getGithubToken();
    const sha = await getTagCommit(dir, tag);
    return {
        info,
        tag,
        sha,
        token,
        githubEveryTicks: token != null ? GITHUB_EVERY_TICKS_WITH_TOKEN : GITHUB_EVERY_TICKS_WITHOUT_TOKEN,
        githubMaxQueries: token != null ? null : GITHUB_MAX_QUERIES_WITHOUT_TOKEN,
        start: Date.now(),
        actionText: 'sin consultar',
        shownRunUrl: null,
        githubQueries: 0,
    };
}

/**
 * @param {WatchState} state
 * @returns {void}
 */
function printHeader(state) {
    const { info, tag, sha, token } = state;
    console.log(`Esperando ${info.name}@${info.version} — ${info.owner}/${info.repo}, tag ${tag}`
        + (sha != null ? ` (${sha.slice(0, 7)})` : ' (tag no encontrado localmente)'));
    if (token == null) {
        console.log(`Sin token de GitHub: ${WORKFLOW_FILE} se consulta cada ${GITHUB_EVERY_TICKS_WITHOUT_TOKEN} s, `
            + `solo ${GITHUB_MAX_QUERIES_WITHOUT_TOKEN} veces.`);
    }
}

/**
 * @param {PackageInfo} info
 * @returns {Promise<{ published: boolean, text: string }>}
 */
async function checkNpm(info) {
    try {
        const published = await isPublishedOnNpm(info.name, info.version);
        return { published, text: published ? 'publicado' : 'no publicado' };
    } catch (err) {
        return { published: false, text: `error (${describeError(err)})` };
    }
}

/**
 * @param {WatchState} state
 * @param {number} tick
 * @returns {boolean}
 */
function shouldQueryGithub(state, tick) {
    const queriesLeft = state.githubMaxQueries == null || state.githubQueries < state.githubMaxQueries;
    return tick % state.githubEveryTicks === 0 && queriesLeft;
}

/**
 * Consulta el workflow, actualiza el estado y devuelve true si terminó sin éxito.
 * @param {WatchState} state
 * @param {string} elapsed
 * @returns {Promise<boolean>}
 */
async function checkWorkflow(state, elapsed) {
    state.githubQueries++;
    try {
        const run = await getWorkflowRun(state.info, state.tag, state.sha, state.token);
        if (run == null) {
            state.actionText = 'todavía sin ejecución';
            return false;
        }
        state.actionText = describeRun(run);
        if (run.htmlUrl !== state.shownRunUrl) {
            console.log(`${elapsed} ejecución: ${run.htmlUrl}`);
            state.shownRunUrl = run.htmlUrl;
        }
        return run.status === 'completed' && run.conclusion !== 'success';
    } catch (err) {
        state.actionText = `error (${describeError(err)})`;
        return false;
    }
}

/**
 * @param {WatchState} state
 * @param {string} elapsed
 * @param {string} npmText
 * @returns {void}
 */
function printStatus(state, elapsed, npmText) {
    const limitText = state.githubMaxQueries != null && state.githubQueries >= state.githubMaxQueries ? ' (sin más consultas)' : '';
    console.log(`${elapsed} npm: ${npmText} | ${WORKFLOW_FILE}: ${state.actionText}${limitText}`);
}

/**
 * Ejecuta una vuelta del ciclo. Devuelve el código de salida si hay que terminar, o null para seguir.
 * @param {WatchState} state
 * @param {number} tick
 * @returns {Promise<number | null>}
 */
async function watchTick(state, tick) {
    const elapsed = formatElapsed(Date.now() - state.start);
    const npm = await checkNpm(state.info);
    if (npm.published) {
        console.log(`${elapsed} publicado en npm: ${state.info.name}@${state.info.version}`);
        return 0;
    }
    const failed = shouldQueryGithub(state, tick) && await checkWorkflow(state, elapsed);
    printStatus(state, elapsed, npm.text);
    if (failed) return 1;
    if (Date.now() - state.start > TIMEOUT_MS) {
        console.log(`Se agotó el tiempo de espera (${TIMEOUT_MS / 60000} min).`);
        return 2;
    }
    return null;
}

/** @returns {Promise<number>} */
async function main() {
    const state = await prepareWatch(resolve(process.argv[2] ?? '.'));
    printHeader(state);
    for (let tick = 0; ; tick++) {
        const tickStart = Date.now();
        const exitCode = await watchTick(state, tick);
        if (exitCode != null) return exitCode;
        await sleep(Math.max(0, TICK_MS - (Date.now() - tickStart)));
    }
}

main().then(
    (code) => { process.exitCode = code; },
    (err) => { console.error(describeError(err)); process.exitCode = 3; },
);
