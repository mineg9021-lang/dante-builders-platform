export type ParityEngineState = 'INITIALIZING' | 'CONNECTING' | 'COLLECTING' | 'ANALYZING' | 'EVALUATING' | 'READY' | 'WAIT' | 'REJECTED' | 'PURCHASING' | 'MONITORING' | 'WON' | 'LOST' | 'PAUSED' | 'STOPPED' | 'RESTARTING';
const transitions: Record<ParityEngineState, ParityEngineState[]> = {
    INITIALIZING: ['CONNECTING', 'STOPPED'], CONNECTING: ['COLLECTING', 'PAUSED', 'STOPPED'],
    COLLECTING: ['ANALYZING', 'WAIT', 'PAUSED', 'STOPPED'], ANALYZING: ['EVALUATING', 'WAIT', 'REJECTED', 'PAUSED', 'STOPPED'],
    EVALUATING: ['READY', 'WAIT', 'REJECTED', 'PAUSED', 'STOPPED'], READY: ['PURCHASING', 'COLLECTING', 'PAUSED', 'STOPPED'],
    WAIT: ['COLLECTING', 'ANALYZING', 'PAUSED', 'STOPPED'], REJECTED: ['COLLECTING', 'PAUSED', 'STOPPED'],
    PURCHASING: ['MONITORING', 'PAUSED', 'STOPPED'], MONITORING: ['WON', 'LOST', 'PAUSED'],
    WON: ['RESTARTING', 'STOPPED', 'PAUSED'], LOST: ['RESTARTING', 'STOPPED', 'PAUSED'],
    PAUSED: ['COLLECTING', 'STOPPED'], STOPPED: ['INITIALIZING'], RESTARTING: ['COLLECTING', 'STOPPED', 'PAUSED'],
};

export class ParityStateMachine {
    private current: ParityEngineState = 'INITIALIZING';
    get state(): ParityEngineState { return this.current; }
    canTransition(next: ParityEngineState): boolean { return transitions[this.current].includes(next); }
    transition(next: ParityEngineState): ParityEngineState {
        if (!this.canTransition(next)) throw new Error('INVALID_PARITY_STATE_TRANSITION:' + this.current + '->' + next);
        this.current = next;
        return this.current;
    }
    /** A new analysis cycle is forbidden while a contract is unresolved. */
    get contractUnresolved(): boolean { return this.current === 'PURCHASING' || this.current === 'MONITORING'; }
}
