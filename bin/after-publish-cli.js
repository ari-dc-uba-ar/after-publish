#!/usr/bin/env node
// @ts-check
/*
 * Uso: after-publish [carpeta-del-paquete]
 *
 * Códigos de salida:
 *   0 publicado en npm
 *   1 el workflow terminó sin éxito (failure, cancelled, etc.)
 *   2 se agotó el tiempo de espera
 *   3 error de configuración (package.json inválido, repositorio no reconocido, etc.)
 */

import { waitForPublish, describeError, EXIT_CODE } from '../after-publish.js';

/** Secuencias ANSI para escribir en amarillo y volver al color normal de la terminal. */
const ANSI_YELLOW = '\u001b[33m';
const ANSI_RESET = '\u001b[0m';

/** Solo se usa color si la salida es una terminal y no se pidió lo contrario con NO_COLOR (https://no-color.org). */
const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;

/**
 * @param {string} line
 * @param {import('../after-publish.js').LogLevel} [level]
 * @returns {void}
 */
function log(line, level = 'info') {
    console.log(level === 'warning' && useColor ? `${ANSI_YELLOW}${line}${ANSI_RESET}` : line);
}

waitForPublish(process.argv[2] ?? '.', log).then(
    (code) => { process.exitCode = code; },
    (err) => { console.error(describeError(err)); process.exitCode = EXIT_CODE.configError; },
);
