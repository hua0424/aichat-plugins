import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { v4 as uuidv4 } from 'uuid';

const MACHINE_CODE_FILE = resolve(process.cwd(), '.machine-code');

/**
 * 获取机器码（首次运行时自动生成并持久化到文件）
 */
export function getMachineCode(): string {
	if (existsSync(MACHINE_CODE_FILE)) {
		const code = readFileSync(MACHINE_CODE_FILE, 'utf-8').trim();
		if (code) {
			return code;
		}
	}

	const code = uuidv4();
	writeFileSync(MACHINE_CODE_FILE, code, 'utf-8');
	console.log(`[machine] Generated new machine code: ${code}`);
	return code;
}
