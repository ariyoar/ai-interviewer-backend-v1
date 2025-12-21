
export interface IInterviewSession {
    handleUserAudio(base64Audio: string): void;
    commitUserAudio(): Promise<void> | void;
    handleAiPlaybackComplete(): void;
}
