import { api } from './api';
import { useApp } from '../store/app';

/** Puts the `udb` command in ~/.local/bin and says how it went */
export async function installCli() {
  try {
    const report = await api.installCli();
    useApp.getState().toast(`${report}\nTry: udb connections`, 'success');
  } catch (e) {
    useApp.getState().toast((e as Error).message, 'error');
  }
}
