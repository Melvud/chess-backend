let audioContext = null;
let timeout = null;
const soundsCache = new Map();
const soundUrls = {
    move: "/sounds/move.mp3",
    capture: "/sounds/capture.mp3",
    illegalMove: "/sounds/error.mp3",
};
export const play = async (sound) => {
    if (timeout)
        clearTimeout(timeout);
    timeout = setTimeout(async () => {
        if (!audioContext)
            audioContext = new AudioContext();
        if (audioContext.state === "suspended")
            await audioContext.resume();
        let audioBuffer = soundsCache.get(soundUrls[sound]);
        if (!audioBuffer) {
            const res = await fetch(soundUrls[sound]);
            const buffer = await audioContext.decodeAudioData(await res.arrayBuffer());
            audioBuffer = buffer;
            soundsCache.set(soundUrls[sound], buffer);
        }
        const audioSrc = audioContext.createBufferSource();
        audioSrc.buffer = audioBuffer;
        const volume = audioContext.createGain();
        volume.gain.value = 0.3;
        audioSrc.connect(volume);
        volume.connect(audioContext.destination);
        audioSrc.start();
    }, 1);
};
export const playCaptureSound = () => play("capture");
export const playIllegalMoveSound = () => play("illegalMove");
export const playMoveSound = () => play("move");
export const playSoundFromMove = (move) => {
    if (!move)
        return playIllegalMoveSound();
    if (move.captured)
        return playCaptureSound();
    return playMoveSound();
};
