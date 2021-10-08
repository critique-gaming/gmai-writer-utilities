import * as vscode from 'vscode';
import { config as awsConfig, Polly, SharedIniFileCredentials } from 'aws-sdk';
import * as tmp from 'tmp';
import { exec } from 'child_process';
import { Readable } from 'stream';
import { createWriteStream } from 'fs';
import { writeFile } from 'fs/promises';

const interpolationsToBreak = (s: string) =>
  s.replace(
    /\${[a-zA-Z_][a-zA-Z_0-9]*}/s,
    '<prosody volume="silent">something</prosody>'
  );

const richtextTags: Set<string> = new Set([
  "a",
  "b",
  "br",
  "shadow",
  "outline",
  "font",
  "i",
  "img",
  "nobr",
  "size",
  "spine",
  // "p", // This is valid in both
  "repeat",
]);

const stripTags = (s: string, tags: Set<string>): string =>
	s.replace(/<\/?([a-zA-Z_][a-zA-Z0-9:_\-]*)[^>]*>/g, (match, capture1) => 
		tags.has(capture1) ? "" : match
	);

async function playVoice(selection: string) {
	selection = selection.replace(/^\s*[a-z_][a-z0-9_]+\s*(\[[a-z0-9_]+\]\s*)/, '');

	if (!selection.includes('<speak>')) {
			selection = `<speak>${selection}</speak>`;
	}

	selection = stripTags(interpolationsToBreak(selection), richtextTags);

	if (selection === "") { return; }
	console.log(`Saying: ${selection}`);

	let conf = vscode.workspace.getConfiguration('gmai-writer-utilities');

	awsConfig.credentials = new SharedIniFileCredentials({
			profile: conf.awsProfile
	});
	const polly = new Polly({
			region: conf.awsRegion
	});

	let audioStream: Buffer | Readable;
	try {
		/* eslint-disable @typescript-eslint/naming-convention */
		const stream = (await polly.synthesizeSpeech({
			OutputFormat: 'mp3',
			Text: selection,
			TextType: 'ssml',
			VoiceId: conf.pollyVoice,
			Engine: conf.pollyEngine,
			LanguageCode: conf.pollyLanguage,
		}).promise()).AudioStream;
		/* eslint-enable @typescript-eslint/naming-convention */

		if (stream === undefined) {
			throw(new Error("Empty response"));
		}
		audioStream = (stream as any);
	} catch (err) {
		vscode.window.showErrorMessage(`Speech synthesis error: ${err}`);
		console.error(err);
		return;
	}

	const { path } = await new Promise((resolve, reject) => {
		tmp.file({
			prefix: 'gmai-speech-', 
			postfix: '.mp3', 
			discardDescriptor: true,
		}, (err: Error | null, path: string, fd: number, cleanup: Function) => {
			if (err) { reject(err); }
			resolve({ path });
		});
	});

	if (audioStream instanceof Readable) {
		const audioStreamStream: Readable = audioStream;
		await new Promise((resolve, reject) => {
			let toStream = createWriteStream(path);
			toStream.on('finish', resolve);
			toStream.on('error', reject);
			audioStreamStream.pipe(toStream);
		});
	} else if (audioStream instanceof Buffer) {
		await writeFile(path, audioStream);
	} else {
		throw new Error("AWS returned a weird object");
	}

	let cmd = '';
	switch (process.platform) {
			case 'darwin': {
					cmd = `osascript -e 'tell application "QuickTime Player"' -e 'set theMovie to open POSIX file "${path}"' -e 'tell theMovie to play' -e 'end tell'`;
					break;
			}
			case 'win32': {
					cmd = `start ${path}`;
					break;
			}
			default: {
					cmd = `xdg-open ${path}`;
					break;
			}
	}

	await new Promise<void>((resolve, reject) => {
		exec(cmd, {}, (err: Error | null, stdout: string, stderr: string) => {
			if (err) { reject(err); }
			resolve();
		});
	});
}

export function activate(context: vscode.ExtensionContext) {
	let disposable = vscode.commands.registerCommand('gmai-writer-utilities.speakSSML', () => {
		const editor = vscode.window.activeTextEditor;
		if (editor === undefined) { return; }

		const selection = editor.selection.isEmpty
			? editor.document.lineAt(editor.selection.start.line).text
			: editor.document.getText(editor.selection);

		playVoice(selection).catch(err => {
			vscode.window.showErrorMessage(err.toString());
			console.error(err);
		});
	});
	context.subscriptions.push(disposable);
}

export function deactivate() {}