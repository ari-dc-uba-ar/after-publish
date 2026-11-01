#!/usr/bin/env node
// @ts-check

import { cli, parseCommandLine, runMain } from 'commendatore';
import { waitForPublish, describeError, EXIT_CODE, EXIT_CODE_DESCRIPTION } from '../after-publish.js';

/** @typedef {import('../after-publish.js').LogLevel} LogLevel */
/** @typedef {import('../after-publish.js').WaitForPublishOptions} WaitForPublishOptions */
/** @typedef {import('commendatore').ExitCode} ExitCode */

/** Secuencias ANSI para escribir en amarillo y volver al color normal de la terminal. */
const ANSI_YELLOW = '\u001b[33m';
const ANSI_RESET = '\u001b[0m';

/** Solo se usa color si la salida es una terminal y no se pidió lo contrario con NO_COLOR (https://no-color.org). */
const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;

/**
 * @param {string} line
 * @param {LogLevel} level
 * @returns {string}
 */
function colored(line, level) {
    return level === 'warning' && useColor ? `${ANSI_YELLOW}${line}${ANSI_RESET}` : line;
}

/**
 * @param {Date} time
 * @returns {string} la hora local como HH:MM
 */
function formatTime(time) {
    return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
}

/**
 * Escribe la salida. Las líneas de estado (las que llegan con hora) empiezan con la hora en que apareció
 * ese mensaje; si el mensaje siguiente es el mismo, en lugar de repetirlo se agrega un punto a esa línea.
 * `close` termina la línea que haya quedado abierta.
 * @param {(text: string) => void} write
 * @returns {{ log: import('../after-publish.js').LogFunction, close: () => void }}
 */
export function createOutput(write) {
    /** el mensaje de la línea de estado abierta (a la que se le agregan puntos), o null si no hay una */
    /** @type {string | null} */
    let openLine = null;
    function close() {
        if (openLine != null) write('\n');
        openLine = null;
    }
    /**
     * @param {string} line
     * @param {LogLevel} [level]
     * @param {Date} [time]
     */
    function log(line, level = 'info', time = undefined) {
        if (time == null) {
            close();
            write(colored(line, level) + '\n');
        } else if (line === openLine) {
            write('.');
        } else {
            close();
            write(colored(`${formatTime(time)} ${line}`, level));
            openLine = line;
        }
    }
    return { log, close };
}

/**
 * @param {string} name
 * @returns {name is keyof typeof EXIT_CODE}
 */
function isExitCodeName(name) {
    return Object.hasOwn(EXIT_CODE, name);
}

/** @type {ExitCode[]} */
const EXIT_CODES = Object.keys(EXIT_CODE).filter(isExitCodeName)
    .map((name) => ({ code: EXIT_CODE[name], description: EXIT_CODE_DESCRIPTION[name] }));

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
    return parseCommandLine({
        moduleUrl: import.meta.url,
        description: 'Espera a que la versión del package.json de [dir] (por omisión, la carpeta actual) aparezca publicada en npm,\n'
            + 'informando el push pendiente, el workflow publish.yml de GitHub Actions y el estado en npm.',
        examples: ['after-publish', 'after-publish ../otro-paquete'],
        exitCodes: EXIT_CODES,
    }, (base) => cli({ ...base, parameters: ['[dir]'] }, undefined, argv)).parsed;
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
    const parsed = parseArgs(argv);
    const output = createOutput((text) => { process.stdout.write(text); });
    /** @type {WaitForPublishOptions} */
    const options = {
        dir: parsed._.dir ?? '.',
        log: output.log,
    };
    try {
        return await waitForPublish(options);
    } catch (err) {
        output.close();
        console.error(describeError(err));
        return EXIT_CODE.configError;
    } finally {
        output.close();
    }
}

if (import.meta.main) {
    runMain(() => main(process.argv.slice(2)), EXIT_CODE.configError);
}
