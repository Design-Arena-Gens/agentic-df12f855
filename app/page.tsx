'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { cidrToRange, enumerateRange, isValidIPv4 } from '@/lib/ipRange';
import { DEFAULT_PORTS, type PortDescriptor } from '@/lib/ports';

type PortStatus = 'responsive' | 'timeout';

type PortScanResult = {
  port: number;
  label: string;
  protocol: 'http' | 'https';
  status: PortStatus;
  latencyMs: number | null;
  method: 'fetch' | 'image';
};

type HostScanResult = {
  ip: string;
  ports: PortScanResult[];
  reachable: boolean;
  completedAt: number;
};

type RangeMode = 'cidr' | 'interval';

const DEFAULT_TIMEOUT = 4000;
const DEFAULT_CONCURRENCY = 24;

function resolveDefaultCidr(): string {
  if (typeof window === 'undefined') {
    return '192.168.0.1/24';
  }

  const { hostname } = window.location;

  if (isValidIPv4(hostname)) {
    const segments = hostname.split('.');
    return `${segments[0]}.${segments[1]}.${segments[2]}.1/24`;
  }

  return '192.168.0.1/24';
}

async function probeViaFetch(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();

  try {
    await fetch(url, {
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal
    });
    const latency = performance.now() - start;
    clearTimeout(timeout);
    return {
      status: 'responsive' as const,
      latency
    };
  } catch (error) {
    clearTimeout(timeout);
    const isAbortError = error instanceof DOMException && error.name === 'AbortError';

    return {
      status: isAbortError ? ('timeout' as const) : ('timeout' as const),
      latency: null
    };
  }
}

async function probeViaImage(url: string, timeoutMs: number) {
  return new Promise<{ status: PortStatus; latency: number | null }>((resolve) => {
    const img = new Image();
    const start = performance.now();
    let settled = false;

    const finalize = (status: PortStatus, latencyOverride?: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        status,
        latency: typeof latencyOverride === 'number' ? latencyOverride : status === 'responsive' ? performance.now() - start : null
      });
    };

    const timeoutId = setTimeout(() => {
      finalize('timeout');
    }, timeoutMs);

    img.onload = () => {
      clearTimeout(timeoutId);
      finalize('responsive');
    };
    img.onerror = () => {
      clearTimeout(timeoutId);
      const elapsed = performance.now() - start;
      finalize(elapsed < timeoutMs ? 'responsive' : 'timeout', elapsed < timeoutMs ? elapsed : null);
    };

    img.src = `${url.replace(/\?$/, '')}?v=${Math.random().toString(36).slice(2)}`;
  });
}

async function probePort(
  ip: string,
  descriptor: PortDescriptor,
  timeoutMs: number
): Promise<PortScanResult> {
  const scheme = descriptor.protocol;
  const url = `${scheme}://${ip}:${descriptor.port}`;
  const prefersFetch =
    (scheme === 'https' && typeof window !== 'undefined') ||
    (typeof window !== 'undefined' && window.location.protocol === 'http:');

  if (prefersFetch && typeof fetch !== 'undefined') {
    const { status, latency } = await probeViaFetch(url, timeoutMs);
    return {
      port: descriptor.port,
      label: descriptor.label,
      protocol: descriptor.protocol,
      status,
      latencyMs: latency,
      method: 'fetch'
    };
  }

  const { status, latency } = await probeViaImage(url, timeoutMs);
  return {
    port: descriptor.port,
    label: descriptor.label,
    protocol: descriptor.protocol,
    status,
    latencyMs: latency,
    method: 'image'
  };
}

async function probeHost(
  ip: string,
  ports: PortDescriptor[],
  timeoutMs: number,
  abortRef: MutableRefObject<boolean>
): Promise<HostScanResult> {
  const results: PortScanResult[] = [];

  for (const descriptor of ports) {
    if (abortRef.current) {
      break;
    }

    try {
      const portResult = await probePort(ip, descriptor, timeoutMs);
      results.push(portResult);
    } catch (error) {
      results.push({
        port: descriptor.port,
        label: descriptor.label,
        protocol: descriptor.protocol,
        status: 'timeout',
        latencyMs: null,
        method: 'image'
      });
    }
  }

  const reachable = results.some((entry) => entry.status === 'responsive');

  return {
    ip,
    ports: results,
    reachable,
    completedAt: Date.now()
  };
}

export default function HomePage() {
  const [mode, setMode] = useState<RangeMode>('cidr');
  const [cidr, setCidr] = useState(resolveDefaultCidr);
  const [startIp, setStartIp] = useState('192.168.0.1');
  const [endIp, setEndIp] = useState('192.168.0.254');
  const [ports, setPorts] = useState<PortDescriptor[]>(DEFAULT_PORTS);
  const [timeoutMs, setTimeoutMs] = useState(DEFAULT_TIMEOUT);
  const [isScanning, setIsScanning] = useState(false);
  const [results, setResults] = useState<HostScanResult[]>([]);
  const [progress, setProgress] = useState({ total: 0, completed: 0, reachable: 0 });
  const abortRef = useRef(false);

  const hostList = useMemo(() => {
    if (mode === 'cidr') {
      const range = cidrToRange(cidr);
      if (!range) {
        return [];
      }
      return enumerateRange(range.start, range.end);
    }

    if (!isValidIPv4(startIp) || !isValidIPv4(endIp)) {
      return [];
    }

    return enumerateRange(startIp, endIp);
  }, [mode, cidr, startIp, endIp]);

  const togglePort = useCallback(
    (descriptor: PortDescriptor) => {
      setPorts((current) => {
        const exists = current.some((item) => item.port === descriptor.port);
        if (exists) {
          return current.filter((item) => item.port !== descriptor.port);
        }
        return [...current, descriptor].sort((a, b) => a.port - b.port);
      });
    },
    [setPorts]
  );

  const reset = useCallback(() => {
    abortRef.current = true;
    setIsScanning(false);
    setResults([]);
    setProgress({ total: 0, completed: 0, reachable: 0 });
  }, []);

  const handleScan = useCallback(async () => {
    if (hostList.length === 0 || ports.length === 0) {
      return;
    }

    abortRef.current = false;
    setIsScanning(true);
    setResults([]);
    setProgress({ total: hostList.length, completed: 0, reachable: 0 });

    const orderedPorts = [...ports].sort((a, b) => a.port - b.port);
    const concurrency = DEFAULT_CONCURRENCY;

    const queue = [...hostList];
    const active: Promise<void>[] = [];

    const schedule = (ip: string) => {
      const worker = (async () => {
        const hostResult = await probeHost(ip, orderedPorts, timeoutMs, abortRef);
        setResults((prev) => {
          const next = [...prev, hostResult];
          return next.sort((a, b) => {
            if (a.reachable && !b.reachable) {
              return -1;
            }
            if (!a.reachable && b.reachable) {
              return 1;
            }
            return a.ip.localeCompare(b.ip, undefined, { numeric: true, sensitivity: 'base' });
          });
        });

        setProgress((prev) => ({
          total: prev.total || hostList.length,
          completed: prev.completed + 1,
          reachable: prev.reachable + (hostResult.reachable ? 1 : 0)
        }));
      })();

      active.push(
        worker.finally(() => {
          const index = active.indexOf(worker);
          if (index !== -1) {
            active.splice(index, 1);
          }
        })
      );
    };

    while (queue.length > 0 && !abortRef.current) {
      while (active.length < concurrency && queue.length > 0) {
        const ip = queue.shift();
        if (ip) {
          schedule(ip);
        }
      }

      await Promise.race(active);
    }

    await Promise.all(active);

    setIsScanning(false);
  }, [hostList, ports, timeoutMs]);

  const responsiveHosts = useMemo(() => results.filter((entry) => entry.reachable), [results]);

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight text-cyan-300">
          Scanner LAN Avançado
        </h1>
        <p className="max-w-3xl text-sm text-slate-300">
          Descubra dispositivos ativos na sua rede local diretamente do navegador. Configure o intervalo de IPs,
          ajuste os serviços desejados e acompanhe os resultados em tempo real. Para maior precisão, execute pelo
          mesmo segmento da rede alvo.
        </p>
      </header>

      <section className="grid gap-6 rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl shadow-cyan-500/5">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="rounded-full border border-cyan-500/40 bg-cyan-500/10 px-3 py-1 font-medium text-cyan-200">
            Intervalo de IPs
          </span>
          <button
            type="button"
            onClick={() => setMode('cidr')}
            className={`rounded-full px-3 py-1 font-medium transition ${
              mode === 'cidr' ? 'bg-cyan-500/80 text-slate-950' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            CIDR
          </button>
          <button
            type="button"
            onClick={() => setMode('interval')}
            className={`rounded-full px-3 py-1 font-medium transition ${
              mode === 'interval'
                ? 'bg-cyan-500/80 text-slate-950'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            Faixa Manual
          </button>
        </div>

        {mode === 'cidr' ? (
          <div className="flex flex-col gap-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">Bloco CIDR</label>
            <input
              value={cidr}
              onChange={(event) => setCidr(event.target.value)}
              placeholder="192.168.0.1/24"
              className="rounded-lg border border-slate-700 bg-slate-950/80 px-4 py-3 text-sm text-slate-200 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/40"
            />
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">IP Inicial</label>
              <input
                value={startIp}
                onChange={(event) => setStartIp(event.target.value)}
                placeholder="192.168.0.1"
                className="rounded-lg border border-slate-700 bg-slate-950/80 px-4 py-3 text-sm text-slate-200 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/40"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">IP Final</label>
              <input
                value={endIp}
                onChange={(event) => setEndIp(event.target.value)}
                placeholder="192.168.0.254"
                className="rounded-lg border border-slate-700 bg-slate-950/80 px-4 py-3 text-sm text-slate-200 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/40"
              />
            </div>
          </div>
        )}

        <div className="grid gap-4">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Serviços / Portas</span>
          <div className="flex flex-wrap gap-3">
            {DEFAULT_PORTS.map((descriptor) => {
              const active = ports.some((item) => item.port === descriptor.port);
              return (
                <button
                  key={descriptor.port}
                  type="button"
                  onClick={() => togglePort(descriptor)}
                  className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
                    active
                      ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200 shadow shadow-cyan-500/20'
                      : 'border-slate-700 bg-slate-900 text-slate-400 hover:border-cyan-400/60 hover:text-cyan-200'
                  }`}
                >
                  {descriptor.label} · {descriptor.port}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-slate-400">
            A varredura utiliza tentativas HTTP/HTTPS passivas para identificar dispositivos respondendo nessas portas.
          </p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 sm:items-end">
          <div className="flex flex-col gap-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">Timeout (ms)</label>
            <input
              type="number"
              min={1000}
              max={10000}
              step={500}
              value={timeoutMs}
              onChange={(event) => setTimeoutMs(Number(event.target.value))}
              className="rounded-lg border border-slate-700 bg-slate-950/80 px-4 py-3 text-sm text-slate-200 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/40"
            />
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleScan}
              disabled={isScanning || hostList.length === 0 || ports.length === 0}
              className="flex-1 rounded-xl bg-cyan-500 px-6 py-3 text-sm font-semibold text-slate-950 shadow-lg shadow-cyan-500/30 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              {isScanning ? 'Escaneando…' : 'Iniciar varredura'}
            </button>
            <button
              type="button"
              onClick={() => {
                if (isScanning) {
                  abortRef.current = true;
                }
                reset();
              }}
              className="rounded-xl border border-slate-700 bg-slate-900 px-5 py-3 text-sm font-semibold text-slate-300 transition hover:border-red-400 hover:text-red-300"
            >
              Cancelar
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
          <p className="font-mono text-xs text-slate-400">
            Hosts no alvo: <span className="text-cyan-300">{hostList.length}</span>
          </p>
          <p className="font-mono text-xs text-slate-400">
            Progresso: <span className="text-cyan-300">{progress.completed}</span>{' '}/ <span className="text-cyan-300">{progress.total}</span>
          </p>
          <p className="font-mono text-xs text-slate-400">
            Respondendo: <span className="text-emerald-300">{progress.reachable}</span>
          </p>
        </div>
      </section>

      <section className="grid gap-6">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl shadow-cyan-500/5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-cyan-200">Dispositivos em Destaque</h2>
            <span className="text-xs text-slate-400">{responsiveHosts.length} detectado(s)</span>
          </div>
          {responsiveHosts.length === 0 ? (
            <p className="text-sm text-slate-400">
              Nenhum host respondeu dentro dos parâmetros definidos até o momento. Ajuste a faixa ou aumente o tempo de
              espera para resultados mais abrangentes.
            </p>
          ) : (
            <div className="grid gap-4">
              {responsiveHosts.map((host) => (
                <article key={host.ip} className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm">
                  <header className="mb-3 flex flex-wrap items-center gap-3">
                    <span className="font-mono text-base font-semibold text-emerald-200">{host.ip}</span>
                    <span className="rounded-full bg-emerald-500/20 px-3 py-1 text-xs uppercase tracking-wide text-emerald-200">
                      ativo
                    </span>
                    <span className="text-[11px] uppercase tracking-wide text-emerald-300/80">
                      atualizado {new Date(host.completedAt).toLocaleTimeString()}
                    </span>
                  </header>
                  <ul className="flex flex-wrap gap-2">
                    {host.ports.map((port) => (
                      <li
                        key={port.port}
                        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium ${
                          port.status === 'responsive'
                            ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-100'
                            : 'border-slate-700 bg-slate-950 text-slate-400'
                        }`}
                      >
                        <span>{port.label}</span>
                        <span className="font-mono">:{port.port}</span>
                        <span className="font-mono text-[11px] text-slate-400">{port.method}</span>
                        {port.latencyMs !== null ? (
                          <span className="font-mono text-[11px] text-slate-300">{Math.round(port.latencyMs)} ms</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl shadow-cyan-500/5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-cyan-200">Todos os resultados</h2>
            <span className="text-xs text-slate-400">{results.length} processado(s)</span>
          </div>

          {results.length === 0 ? (
            <p className="text-sm text-slate-400">
              A lista agregará todos os IPs analisados durante a varredura com o status de cada porta monitorada.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-800">
              <table className="min-w-full divide-y divide-slate-800 text-left text-sm">
                <thead className="bg-slate-900/80 text-xs uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-semibold">IP</th>
                    {ports
                      .slice()
                      .sort((a, b) => a.port - b.port)
                      .map((port) => (
                        <th key={port.port} className="px-4 py-3 font-semibold">
                          {port.port}
                        </th>
                      ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-900/60 bg-slate-950/60">
                  {results.map((host) => (
                    <tr key={host.ip} className="hover:bg-slate-900/50">
                      <td className="px-4 py-3 font-mono text-slate-200">{host.ip}</td>
                      {ports
                        .slice()
                        .sort((a, b) => a.port - b.port)
                        .map((descriptor) => {
                          const report = host.ports.find((entry) => entry.port === descriptor.port);
                          return (
                            <td key={descriptor.port} className="px-4 py-3">
                              {report ? (
                                <span
                                  className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-wide ${
                                    report.status === 'responsive'
                                      ? 'bg-emerald-500/20 text-emerald-200'
                                      : 'bg-slate-800 text-slate-400'
                                  }`}
                                >
                                  {report.status === 'responsive' ? 'ativo' : 'n/d'}
                                </span>
                              ) : (
                                <span className="text-xs text-slate-500">—</span>
                              )}
                            </td>
                          );
                        })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
