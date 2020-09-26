import { BANDWIDTH_ESTIMATE } from 'events/events';
import { isValidNumber } from 'utils/underscore';
import type { ImplementedProvider } from './default';

export type BandwidthMonitor = {
    start: () => void;
    stop: () => void;
    getEstimate: () => number;
}

export default function BandwidthMonitor(provider: ImplementedProvider, initialEstimate: number): BandwidthMonitor {
    let bandwidthMonitorInterval: number | undefined;
    let bandwidthEstimate = initialEstimate;
    return {
        start(): void {
            this.stop();
            bandwidthMonitorInterval = window.setInterval(() => {
                const bwEstimate = provider.getBandwidthEstimate();
                if (!isValidNumber(bwEstimate)) {
                    return;
                }
                bandwidthEstimate = bwEstimate;
                provider.trigger(BANDWIDTH_ESTIMATE, {
                    bandwidthEstimate
                });
            }, 1000);
        },
        stop(): void {
            clearInterval(bandwidthMonitorInterval);
        },
        getEstimate(): number {
            return bandwidthEstimate;
        }
    };
}
