import { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, ScrollView,
  StyleSheet, SafeAreaView, StatusBar, KeyboardAvoidingView,
  Platform, ActivityIndicator, Alert
} from 'react-native';
import { Audio } from 'expo-av';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';

const API_URL = 'https://remy-nu.vercel.app';
// Shared token for this internal field app — must match MOBILE_API_TOKEN
// in the Remy Vercel project. Identifies the app to /api/jobs,
// /api/doctrine-list, and /api/chat (which returns JSON for this caller).
const MOBILE_API_TOKEN = 'rmt_c31bb3dfdd42c99783497422897aabcf344a96567c8a4ac35fb5dff3e67fa29f';
const AUTH_HEADERS = { Authorization: `Bearer ${MOBILE_API_TOKEN}` };

const VOICES = [
  { id: 'f786b574-daa5-4673-aa0c-cbe3e8534c02', name: 'Remy' },
  { id: '30894953-bcce-41fe-892c-15ce19c843ff', name: 'Parker' },
  { id: '692846ad-1a6b-49b8-bfc5-86421fd41a19', name: 'Thandi' },
  { id: 'ed9ccfa4-8fa1-40f8-bfb2-cb7d67d2f9cd', name: 'Ruby' },
  { id: 'ef191366-f52f-447a-a398-ed8c0f2943a1', name: 'Archie' },
  { id: '34575e71-908f-4ab6-ab54-b08c95d6597d', name: 'Joey' },
];

const JOB_TYPE_COLORS: Record<string, string> = {
  roofing: '#f07a2e', fencing: '#4a9fd4', hvac: '#3daf76',
  painting: '#9b59b6', plumbing: '#e74c3c', solar: '#f1c40f',
  restoration: '#e67e22', other: '#7a8fa4',
};

const COLORS = {
  bg: '#0b0f14', bg2: '#111820', border: 'rgba(255,255,255,0.07)',
  orange: '#f07a2e', orangeDim: 'rgba(240,122,46,0.1)', orangeBorder: 'rgba(240,122,46,0.25)',
  text: '#e8edf2', textDim: '#7a8fa4', textFaint: '#2d3f52', green: '#3daf76',
};

type Message = { role: 'user' | 'assistant'; content: string };
type Job = { id: string; customer_name: string; address: string; notes: string; status: string; job_type: string };
type Tab = 'voice' | 'jobs' | 'settings';

export default function App() {
  const [tab, setTab] = useState<Tab>('voice');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  const [doctrine, setDoctrine] = useState('');
  const [gpsEnabled, setGpsEnabled] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState(VOICES[0].id);
  const scrollRef = useRef<ScrollView>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const gpsIntervalRef = useRef<any>(null);
  const briefedJobsRef = useRef<Set<string>>(new Set());
  const geocodeCacheRef = useRef<Map<string, {lat: number; lng: number} | null>>(new Map());

  useEffect(() => {
    setupAudio();
    loadSavedToken();
    loadSavedVoice();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [messages]);

  useEffect(() => {
    if (gpsEnabled) startGPS();
    else stopGPS();
    return () => stopGPS();
  }, [gpsEnabled, jobs]);

  const setupAudio = async () => {
    await Audio.requestPermissionsAsync();
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      shouldDuckAndroid: true,
      staysActiveInBackground: true,
      playThroughEarpieceAndroid: false,
    });
  };

  const loadSavedVoice = async () => {
    const saved = await SecureStore.getItemAsync('remy_voice');
    if (saved) setSelectedVoice(saved);
  };

  const saveVoice = async (id: string) => {
    setSelectedVoice(id);
    await SecureStore.setItemAsync('remy_voice', id);
  };

  const loadSavedToken = async () => {
    const saved = await SecureStore.getItemAsync('remy_token');
    if (saved) { setToken(saved); loadData(); }
    else setShowLogin(true);
  };

  const login = async () => {
    const t = `${email}_${Date.now()}`;
    await SecureStore.setItemAsync('remy_token', t);
    setToken(t);
    setShowLogin(false);
    loadData();
  };

  const logout = async () => {
    await SecureStore.deleteItemAsync('remy_token');
    setToken(null);
    setMessages([]);
    setActiveJob(null);
    setShowLogin(true);
  };

  const loadData = async () => {
    try {
      const [jobData, docData] = await Promise.all([
        fetch(`${API_URL}/api/jobs`, { headers: AUTH_HEADERS }).then(r => r.json()).catch(() => ({ jobs: [] })),
        fetch(`${API_URL}/api/doctrine-list`, { headers: AUTH_HEADERS }).then(r => r.json()).catch(() => ({ doctrine: '' })),
      ]);
      if (jobData.jobs) setJobs(jobData.jobs);
      if (docData.doctrine) setDoctrine(docData.doctrine);
      setMessages([{ role: 'assistant', content: `Hey. I am Remy. ${jobData.jobs?.length > 0 ? `${jobData.jobs.length} active job${jobData.jobs.length > 1 ? 's' : ''} loaded. Select a job and tap Brief Me when you are ready.` : 'No active jobs yet. Add jobs from the web dashboard.'}` }]);
    } catch {
      setMessages([{ role: 'assistant', content: `Hey. I am Remy. Ready when you are.` }]);
    }
  };

  const atJobRef = useRef<{job: Job; arrivedAt: number; lat: number; lng: number} | null>(null);
  const departedJobsRef = useRef<Set<string>>(new Set());

  const startGPS = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') { setGpsEnabled(false); Alert.alert('GPS needed', 'Enable location to use auto-brief.'); return; }
    gpsIntervalRef.current = setInterval(async () => {
      try {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        await processLocation(loc.coords.latitude, loc.coords.longitude);
      } catch {}
    }, 15000);
  };

  const stopGPS = () => {
    if (gpsIntervalRef.current) { clearInterval(gpsIntervalRef.current); gpsIntervalRef.current = null; }
  };

  const getDistance = (lat1: number, lng1: number, lat2: number, lng2: number) => {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  };

  const geocodeAddress = async (address: string): Promise<{lat: number; lng: number} | null> => {
    const cached = geocodeCacheRef.current.get(address);
    if (cached !== undefined) return cached;
    try {
      const res = await fetch(`${API_URL}/api/geo?action=geocode&address=${encodeURIComponent(address)}`);
      const data = await res.json();
      const location = data.location || null;
      geocodeCacheRef.current.set(address, location);
      return location;
    } catch {}
    return null;
  };

  const getNearbyFood = async (lat: number, lng: number): Promise<string> => {
    try {
      const res = await fetch(`${API_URL}/api/geo?action=nearby&lat=${lat}&lng=${lng}&type=restaurant`);
      const data = await res.json();
      const places = data.places?.slice(0, 3).map((p: any) => `${p.name} (${p.vicinity})`).join(', ');
      return places || '';
    } catch { return ''; }
  };

  const processLocation = async (userLat: number, userLng: number) => {
    const hour = new Date().getHours();

    // Check if near any job
    for (const job of jobs) {
      if (!job.address) continue;
      const coords = await geocodeAddress(job.address);
      if (!coords) continue;
      const dist = getDistance(userLat, userLng, coords.lat, coords.lng);

      // Arrived at job
      if (dist <= 400 && !briefedJobsRef.current.has(job.id)) {
        briefedJobsRef.current.add(job.id);
        atJobRef.current = { job, arrivedAt: Date.now(), lat: coords.lat, lng: coords.lng };
        setActiveJob(job);
        setTab('voice');
        sendMessage(
          `I am pulling up to ${job.customer_name} at ${job.address}. Auto-detected via GPS. Brief me fast.`,
          messages, doctrine, job
        );
        return;
      }

      // Departed job â€” was at job, now more than 600m away
      if (atJobRef.current?.job.id === job.id && dist > 600 && !departedJobsRef.current.has(job.id)) {
        departedJobsRef.current.add(job.id);
        const timeAtJob = Math.round((Date.now() - atJobRef.current.arrivedAt) / 60000);
        atJobRef.current = null;

        // Find next job
        const nextJob = jobs.find(j => j.id !== job.id && !departedJobsRef.current.has(j.id));

        // Only suggest food during lunch hours (10am - 2pm) with enough gap
        if (hour >= 10 && hour <= 14) {
          const food = await getNearbyFood(userLat, userLng);
          const nextJobText = nextJob ? ` Your next stop is ${nextJob.customer_name}.` : ' You have no more jobs loaded.';
          const foodText = food ? ` Nearby options: ${food}.` : '';
          sendMessage(
            `Just left ${job.customer_name} after ${timeAtJob} minutes on site.${nextJobText}${foodText} What do you need?`,
            messages, doctrine, nextJob || null
          );
        } else {
          const nextJobText = nextJob ? `Next up is ${nextJob.customer_name} at ${nextJob.address}.` : 'No more jobs loaded.';
          sendMessage(
            `Left ${job.customer_name}.${nextJobText} Ready when you are.`,
            messages, doctrine, nextJob || null
          );
        }
        return;
      }
    }
  };

  const checkNearbyJobs = async (userLat: number, userLng: number) => {
    await processLocation(userLat, userLng);
  };

  const sendMessage = async (text: string, currentMessages: Message[], currentDoctrine: string, currentJob: Job | null) => {
    if (!text.trim()) return;
    const jobContext = currentJob ? `Customer: ${currentJob.customer_name}\nAddress: ${currentJob.address || 'Not provided'}\nNotes: ${currentJob.notes || 'None'}\nJob type: ${currentJob.job_type || 'General'}` : '';
    const newMessages: Message[] = [...currentMessages, { role: 'user', content: text }];
    setMessages(newMessages);
    setInput('');
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
        body: JSON.stringify({ messages: newMessages, doctrine: currentDoctrine, jobContext }),
      });
      const data = await res.json();
      const reply = data.message || 'Something went wrong.';
      setMessages([...newMessages, { role: 'assistant', content: reply }]);
      await speakText(reply);
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Connection issue. Try again.' }]);
    }
    setLoading(false);
  };

  const speakText = async (text: string) => {
    try {
      if (soundRef.current) { await soundRef.current.stopAsync(); await soundRef.current.unloadAsync(); soundRef.current = null; }
      setIsSpeaking(true);
      const res = await fetch(`${API_URL}/api/voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
        body: JSON.stringify({ text, voiceId: selectedVoice }),
      });
      if (!res.ok) { setIsSpeaking(false); return; }
      const blob = await res.blob();
      const reader = new FileReader();
      reader.onloadend = async () => {
        try {
          const base64 = (reader.result as string).split(',')[1];
          const { sound } = await Audio.Sound.createAsync(
            { uri: `data:audio/mpeg;base64,${base64}` },
            { shouldPlay: true, volume: 1.0 }
          );
          soundRef.current = sound;
          sound.setOnPlaybackStatusUpdate((status) => {
            if (status.isLoaded && status.didJustFinish) { setIsSpeaking(false); sound.unloadAsync(); soundRef.current = null; }
          });
        } catch { setIsSpeaking(false); }
      };
      reader.readAsDataURL(blob);
    } catch { setIsSpeaking(false); }
  };

  const stopSpeaking = async () => {
    if (soundRef.current) { await soundRef.current.stopAsync(); await soundRef.current.unloadAsync(); soundRef.current = null; }
    setIsSpeaking(false);
  };

  const startRecording = async () => {
    try {
      if (isSpeaking) await stopSpeaking();
      await Audio.setAudioModeAsync({ 
        allowsRecordingIOS: true, 
        playsInSilentModeIOS: true,
        playThroughEarpieceAndroid: false,
      });
      const { recording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      recordingRef.current = recording;
      setIsRecording(true);
      // Auto-stop after 8 seconds
      setTimeout(async () => {
        if (recordingRef.current) await stopRecording();
      }, 8000);
    } catch { Alert.alert('Error', 'Could not start recording.'); }
  };

  const stopRecording = async () => {
    if (!recordingRef.current) return;
    setIsRecording(false);
    try {
      await recordingRef.current.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ 
        allowsRecordingIOS: false, 
        playsInSilentModeIOS: true,
        playThroughEarpieceAndroid: false,
      });
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;
      if (uri) await transcribeAudio(uri);
    } catch { recordingRef.current = null; }
  };

  const transcribeAudio = async (uri: string) => {
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append('audio', { uri, type: 'audio/m4a', name: 'recording.m4a' } as any);
      const res = await fetch(`${API_URL}/api/transcribe`, { method: 'POST', headers: AUTH_HEADERS, body: formData });
      const data = await res.json();
      if (data.text) await sendMessage(data.text, messages, doctrine, activeJob);
      else setLoading(false);
    } catch { setLoading(false); }
  };

  const selectJob = (job: Job) => {
    setActiveJob(job);
    setTab('voice');
    setMessages(prev => [...prev, { role: 'assistant', content: `Job loaded: ${job.customer_name}${job.address ? ` at ${job.address}` : ''}. Tap Brief Me when you are ready.` }]);
  };

  const briefActiveJob = () => {
    if (!activeJob) return;
    sendMessage(
      `Brief me fast. Pulling up to ${activeJob.customer_name}${activeJob.address ? ` at ${activeJob.address}` : ''}${activeJob.notes ? `. Notes: ${activeJob.notes}` : ''}.`,
      messages, doctrine, activeJob
    );
  };

  const briefMyDay = () => {
    if (jobs.length === 0) return;
    const jobList = jobs.slice(0, 5).map(j => j.customer_name).join(', ');
    sendMessage(`Brief me on my day. I have ${jobs.length} active jobs: ${jobList}.`, messages, doctrine, null);
  };

  const clearJob = () => {
    setActiveJob(null);
    setMessages(prev => [...prev, { role: 'assistant', content: 'Job cleared. Select a new job or ask me anything.' }]);
  };

  if (showLogin) {
    return (
      <SafeAreaView style={[styles.container, { justifyContent: 'center', padding: 24 }]}>
        <StatusBar barStyle="light-content" backgroundColor={COLORS.bg} />
        <Text style={styles.logo}>Remy<Text style={{ color: COLORS.orange }}>.</Text></Text>
        <Text style={styles.loginSub}>Your AI field companion</Text>
        <TextInput style={styles.loginInput} placeholder="Email" placeholderTextColor={COLORS.textFaint} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
        <TextInput style={styles.loginInput} placeholder="Password" placeholderTextColor={COLORS.textFaint} value={password} onChangeText={setPassword} secureTextEntry />
        <TouchableOpacity style={styles.loginBtn} onPress={login}>
          <Text style={styles.loginBtnText}>Sign In</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.bg} />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => setTab('voice')}>
          <Text style={styles.logo}>Remy<Text style={{ color: COLORS.orange }}>.</Text></Text>
        </TouchableOpacity>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {isSpeaking && (
            <TouchableOpacity onPress={stopSpeaking}>
              <Text style={[styles.statusText, { color: COLORS.green }]}>Speaking (stop)</Text>
            </TouchableOpacity>
          )}
          {isRecording && <Text style={[styles.statusText, { color: COLORS.orange }]}>Listening...</Text>}
          {activeJob && !isSpeaking && !isRecording && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <View style={[styles.jobPill, { borderColor: (JOB_TYPE_COLORS[activeJob.job_type] || COLORS.orange) + '44' }]}>
                <Text style={[styles.jobPillText, { color: JOB_TYPE_COLORS[activeJob.job_type] || COLORS.orange }]} numberOfLines={1}>{activeJob.customer_name}</Text>
              </View>
              <TouchableOpacity onPress={clearJob} style={styles.clearBtn}><Text style={styles.clearBtnText}>x</Text></TouchableOpacity>
            </View>
          )}
        </View>
      </View>

      {/* Brief buttons */}
      {tab === 'voice' && !isSpeaking && !isRecording && (
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: COLORS.border }}>
          {activeJob ? (
            <TouchableOpacity onPress={briefActiveJob} style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: COLORS.orangeDim, borderWidth: 1, borderColor: COLORS.orangeBorder }}>
              <Text style={{ color: COLORS.orange, fontSize: 12, fontWeight: '600' }}>Brief Me</Text>
            </TouchableOpacity>
          ) : jobs.length > 0 ? (
            <TouchableOpacity onPress={briefMyDay} style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: 'rgba(61,175,118,0.1)', borderWidth: 1, borderColor: 'rgba(61,175,118,0.25)' }}>
              <Text style={{ color: COLORS.green, fontSize: 12, fontWeight: '600' }}>Brief My Day</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity onPress={() => setTab('jobs')} style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: COLORS.bg2, borderWidth: 1, borderColor: COLORS.border }}>
            <Text style={{ color: COLORS.textDim, fontSize: 12, fontWeight: '500' }}>{activeJob ? 'Change Job' : '+ Select Job'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {tab === 'voice' && (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView ref={scrollRef} style={styles.messages} contentContainerStyle={{ padding: 16, gap: 12 }}>
            {messages.map((m, i) => (
              <View key={i} style={[styles.msgRow, m.role === 'user' ? styles.msgRowUser : styles.msgRowRemy]}>
                {m.role === 'assistant' && <View style={styles.avatar}><Text style={styles.avatarText}>R</Text></View>}
                <View style={[styles.bubble, m.role === 'user' ? styles.bubbleUser : styles.bubbleRemy]}>
                  <Text style={[styles.bubbleText, m.role === 'user' ? styles.bubbleTextUser : styles.bubbleTextRemy]}>{m.content}</Text>
                </View>
              </View>
            ))}
            {loading && (
              <View style={[styles.msgRow, styles.msgRowRemy]}>
                <View style={styles.avatar}><Text style={styles.avatarText}>R</Text></View>
                <View style={[styles.bubble, styles.bubbleRemy]}><ActivityIndicator size="small" color={COLORS.orange} /></View>
              </View>
            )}
          </ScrollView>
          <View style={styles.inputBar}>
            <TouchableOpacity style={[styles.micBtn, isRecording && styles.micBtnActive]} onPress={isRecording ? stopRecording : startRecording}>
              <Text style={[styles.micBtnText, isRecording && { color: '#fff' }]}>{isRecording ? 'Done' : 'Mic'}</Text>
            </TouchableOpacity>
            <TextInput style={styles.textInput} value={input} onChangeText={setInput} placeholder={isRecording ? 'Listening...' : 'Type or tap mic...'} placeholderTextColor={COLORS.textFaint} onSubmitEditing={() => sendMessage(input, messages, doctrine, activeJob)} returnKeyType="send" editable={!isRecording} />
            <TouchableOpacity style={[styles.sendBtn, (!input.trim() || loading) && styles.sendBtnDisabled]} onPress={() => sendMessage(input, messages, doctrine, activeJob)} disabled={!input.trim() || loading}>
              <Text style={styles.sendBtnText}>Send</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      )}

      {tab === 'jobs' && (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20 }}>
          <Text style={styles.tabTitle}>Active Jobs</Text>
          <Text style={styles.tabSub}>Tap a job to load it, then tap Brief Me</Text>
          {jobs.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateText}>No active jobs. Add from the web dashboard at remy-nu.vercel.app</Text>
            </View>
          ) : jobs.map(job => {
            const color = JOB_TYPE_COLORS[job.job_type] || COLORS.orange;
            return (
              <TouchableOpacity key={job.id} style={[styles.jobCard, activeJob?.id === job.id && { borderColor: color + '66', backgroundColor: color + '11' }]} onPress={() => selectJob(job)}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
                    <Text style={styles.jobCardName}>{job.customer_name}</Text>
                    <Text style={{ fontSize: 10, color, fontWeight: '600', textTransform: 'uppercase' }}>{job.job_type}</Text>
                  </View>
                  {job.address ? <Text style={styles.jobCardAddr}>{job.address}</Text> : null}
                  {job.notes ? <Text style={styles.jobCardNotes} numberOfLines={1}>{job.notes}</Text> : null}
                </View>
                <View style={[styles.jobCardBtn, { borderColor: color + '44' }]}>
                  <Text style={[styles.jobCardBtnText, { color }]}>Load</Text>
                </View>
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity style={styles.refreshBtn} onPress={loadData}>
            <Text style={styles.refreshBtnText}>Refresh Jobs</Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      {tab === 'settings' && (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20 }}>
          <Text style={styles.tabTitle}>Settings</Text>

          <View style={styles.settingsCard}>
            <Text style={styles.settingsLabel}>REMY VOICE</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              {VOICES.map(v => (
                <TouchableOpacity key={v.id} onPress={() => saveVoice(v.id)} style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: selectedVoice === v.id ? COLORS.orange : COLORS.bg, borderWidth: 1, borderColor: selectedVoice === v.id ? COLORS.orange : COLORS.border }}>
                  <Text style={{ color: selectedVoice === v.id ? '#fff' : COLORS.textDim, fontSize: 13, fontWeight: '500' }}>{v.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View style={[styles.settingsCard, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }]}>
            <View>
              <Text style={styles.settingsLabel}>GPS AUTO-BRIEF</Text>
              <Text style={[styles.settingsValue, { fontSize: 12, color: COLORS.textFaint }]}>Auto-brief when near job address</Text>
            </View>
            <TouchableOpacity onPress={() => setGpsEnabled(!gpsEnabled)} style={{ backgroundColor: gpsEnabled ? COLORS.orange : 'rgba(255,255,255,0.06)', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8 }}>
              <Text style={{ color: gpsEnabled ? '#fff' : COLORS.textDim, fontSize: 13, fontWeight: '600' }}>{gpsEnabled ? 'ON' : 'OFF'}</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.settingsCard}>
            <Text style={styles.settingsLabel}>ACTIVE JOB</Text>
            <Text style={styles.settingsValue}>{activeJob ? activeJob.customer_name : 'None'}</Text>
          </View>

          <View style={styles.settingsCard}>
            <Text style={styles.settingsLabel}>JOBS LOADED</Text>
            <Text style={styles.settingsValue}>{jobs.length}</Text>
          </View>

          <TouchableOpacity style={styles.refreshBtn} onPress={loadData}>
            <Text style={styles.refreshBtnText}>Refresh Data</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.refreshBtn, { backgroundColor: 'rgba(200,74,74,0.1)', borderColor: 'rgba(200,74,74,0.25)', marginTop: 8 }]} onPress={logout}>
            <Text style={[styles.refreshBtnText, { color: '#c84a4a' }]}>Sign Out</Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      <View style={styles.tabBar}>
        {(['voice', 'jobs', 'settings'] as Tab[]).map(t => (
          <TouchableOpacity key={t} style={styles.tabBtn} onPress={() => setTab(t)}>
            <Text style={[styles.tabLabel, tab === t && styles.tabLabelActive]}>
              {t === 'voice' ? 'Remy' : t === 'jobs' ? 'Jobs' : 'Settings'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderBottomWidth: 1, borderBottomColor: COLORS.border, backgroundColor: 'rgba(11,15,20,0.98)' },
  logo: { fontSize: 20, fontWeight: '800', color: COLORS.text, letterSpacing: -0.5 },
  statusText: { fontSize: 11, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase' },
  jobPill: { backgroundColor: COLORS.orangeDim, borderWidth: 1, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4, maxWidth: 120 },
  jobPillText: { fontSize: 11, fontWeight: '500' },
  clearBtn: { width: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center' },
  clearBtnText: { color: COLORS.textDim, fontSize: 11 },
  messages: { flex: 1 },
  msgRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginBottom: 2 },
  msgRowUser: { justifyContent: 'flex-end' },
  msgRowRemy: { justifyContent: 'flex-start' },
  avatar: { width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(240,122,46,0.15)', borderWidth: 1, borderColor: COLORS.orangeBorder, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: COLORS.orange, fontSize: 11, fontWeight: '700' },
  bubble: { maxWidth: '80%', padding: 11, borderRadius: 18 },
  bubbleUser: { backgroundColor: '#1a2535', borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)', borderBottomRightRadius: 4 },
  bubbleRemy: { backgroundColor: 'rgba(240,122,46,0.06)', borderWidth: 1, borderColor: 'rgba(240,122,46,0.15)', borderBottomLeftRadius: 4 },
  bubbleText: { fontSize: 15, lineHeight: 22 },
  bubbleTextUser: { color: '#8a9db5' },
  bubbleTextRemy: { color: COLORS.text },
  inputBar: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: COLORS.border, backgroundColor: 'rgba(11,15,20,0.98)' },
  micBtn: { width: 48, height: 48, borderRadius: 24, backgroundColor: COLORS.orangeDim, borderWidth: 1.5, borderColor: COLORS.orangeBorder, alignItems: 'center', justifyContent: 'center' },
  micBtnActive: { backgroundColor: COLORS.orange, borderWidth: 0 },
  micBtnText: { fontSize: 13, fontWeight: '600', color: COLORS.orange },
  sendBtn: { paddingHorizontal: 18, paddingVertical: 13, backgroundColor: COLORS.orange, borderRadius: 24 },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnText: { color: '#fff', fontSize: 14, fontWeight: '500' },
  textInput: { flex: 1, backgroundColor: COLORS.bg2, borderWidth: 1, borderColor: COLORS.border, borderRadius: 24, paddingHorizontal: 16, paddingVertical: 12, color: COLORS.text, fontSize: 16 },
  tabBar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: COLORS.border, backgroundColor: 'rgba(11,15,20,0.98)', paddingBottom: Platform.OS === 'ios' ? 8 : 0 },
  tabBtn: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  tabLabel: { fontSize: 12, color: COLORS.textFaint, fontWeight: '500' },
  tabLabelActive: { color: COLORS.orange, fontWeight: '600' },
  tabTitle: { fontSize: 22, fontWeight: '800', color: COLORS.text, marginBottom: 6, letterSpacing: -0.5 },
  tabSub: { fontSize: 13, color: COLORS.textDim, marginBottom: 20, fontWeight: '300' },
  emptyState: { backgroundColor: COLORS.bg2, borderRadius: 12, padding: 24, alignItems: 'center' },
  emptyStateText: { color: COLORS.textFaint, fontSize: 13, textAlign: 'center', lineHeight: 20 },
  jobCard: { backgroundColor: COLORS.bg2, borderWidth: 1, borderColor: COLORS.border, borderRadius: 12, padding: 16, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 12 },
  jobCardName: { fontSize: 15, fontWeight: '600', color: COLORS.text },
  jobCardAddr: { fontSize: 12, color: COLORS.textDim, marginTop: 2 },
  jobCardNotes: { fontSize: 12, color: COLORS.textFaint, marginTop: 4 },
  jobCardBtn: { backgroundColor: COLORS.orangeDim, borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  jobCardBtnText: { fontSize: 13, fontWeight: '600' },
  refreshBtn: { backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, padding: 14, alignItems: 'center', marginTop: 16 },
  refreshBtnText: { color: COLORS.textDim, fontSize: 14, fontWeight: '500' },
  settingsCard: { backgroundColor: COLORS.bg2, borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, padding: 16, marginBottom: 10 },
  settingsLabel: { fontSize: 10, fontWeight: '600', letterSpacing: 1, color: COLORS.textFaint, textTransform: 'uppercase', marginBottom: 4 },
  settingsValue: { fontSize: 14, color: COLORS.text },
  loginInput: { backgroundColor: COLORS.bg2, borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, padding: 14, color: COLORS.text, fontSize: 16, marginBottom: 12 },
  loginBtn: { backgroundColor: COLORS.orange, borderRadius: 10, padding: 15, alignItems: 'center', marginTop: 8 },
  loginBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  loginSub: { color: COLORS.textDim, fontSize: 15, marginBottom: 32, marginTop: 8 },
});
