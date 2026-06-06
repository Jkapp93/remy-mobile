import { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, ScrollView,
  StyleSheet, SafeAreaView, StatusBar, KeyboardAvoidingView,
  Platform, ActivityIndicator, Alert
} from 'react-native';
import { Audio } from 'expo-av';
import * as SecureStore from 'expo-secure-store';

const API_URL = 'https://remy-nu.vercel.app';

const COLORS = {
  bg: '#0b0f14',
  bg2: '#111820',
  border: 'rgba(255,255,255,0.07)',
  orange: '#f07a2e',
  orangeDim: 'rgba(240,122,46,0.1)',
  orangeBorder: 'rgba(240,122,46,0.25)',
  text: '#e8edf2',
  textDim: '#7a8fa4',
  textFaint: '#2d3f52',
  green: '#3daf76',
};

type Message = { role: 'user' | 'assistant'; content: string };
type Job = { id: string; customer_name: string; address: string; notes: string; status: string };
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
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);

  useEffect(() => {
    setupAudio();
    loadSavedToken();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [messages]);

  const setupAudio = async () => {
    await Audio.requestPermissionsAsync();
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      shouldDuckAndroid: true,
      staysActiveInBackground: true,
    });
  };

  const unlockAudio = async () => {
    if (audioUnlocked) return;
    try {
      const { sound } = await Audio.Sound.createAsync(
        { uri: `${API_URL}/silence.mp3` },
        { shouldPlay: true, volume: 0 }
      );
      await sound.unloadAsync();
      setAudioUnlocked(true);
    } catch { setAudioUnlocked(true); }
  };

  const loadSavedToken = async () => {
    const saved = await SecureStore.getItemAsync('remy_token');
    if (saved) { setToken(saved); loadData(); }
    else setShowLogin(true);
  };

  const login = async () => {
    await unlockAudio();
    const t = `${email}_${Date.now()}`;
    await SecureStore.setItemAsync('remy_token', t);
    setToken(t);
    setShowLogin(false);
    loadData();
  };

  const logout = async () => {
    await SecureStore.deleteItemAsync('remy_token');
    setToken(null);
    setShowLogin(true);
    setMessages([]);
    setActiveJob(null);
  };

  const loadData = async () => {
    try {
      const [jobData, docData] = await Promise.all([
        fetch(`${API_URL}/api/jobs`).then(r => r.json()).catch(() => ({ jobs: [] })),
        fetch(`${API_URL}/api/doctrine-list`).then(r => r.json()).catch(() => ({ doctrine: '' })),
      ]);
      if (jobData.jobs) setJobs(jobData.jobs);
      if (docData.doctrine) setDoctrine(docData.doctrine);
      if (jobData.jobs?.length > 0) {
        const jobList = jobData.jobs.slice(0, 3).map((j: Job) => j.customer_name).join(', ');
        await sendMessage(
          `Brief me on my day. I have ${jobData.jobs.length} active job${jobData.jobs.length > 1 ? 's' : ''}: ${jobList}.`,
          [], docData.doctrine || '', null
        );
      } else {
        setMessages([{ role: 'assistant', content: `Hey. I am Remy. No active jobs yet. Tap Jobs below to add one, or just tell me what you are walking into.` }]);
      }
    } catch {
      setMessages([{ role: 'assistant', content: `Hey. I am Remy. Ready when you are.` }]);
    }
  };

  const sendMessage = async (text: string, currentMessages: Message[], currentDoctrine: string, currentJob: Job | null) => {
    if (!text.trim()) return;
    const jobContext = currentJob ? `Customer: ${currentJob.customer_name}\nAddress: ${currentJob.address || 'Not provided'}\nNotes: ${currentJob.notes || 'None'}` : '';
    const newMessages: Message[] = [...currentMessages, { role: 'user', content: text }];
    setMessages(newMessages);
    setInput('');
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
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
            if (status.isLoaded && status.didJustFinish) {
              setIsSpeaking(false);
              sound.unloadAsync();
              soundRef.current = null;
            }
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
      await unlockAudio();
      if (isSpeaking) await stopSpeaking();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      recordingRef.current = recording;
      setIsRecording(true);
    } catch { Alert.alert('Error', 'Could not start recording.'); }
  };

  const stopRecording = async () => {
    if (!recordingRef.current) return;
    setIsRecording(false);
    try {
      await recordingRef.current.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
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
      const res = await fetch(`${API_URL}/api/transcribe`, { method: 'POST', body: formData });
      const data = await res.json();
      if (data.text) await sendMessage(data.text, messages, doctrine, activeJob);
      else setLoading(false);
    } catch { setLoading(false); }
  };

  const selectJob = async (job: Job) => {
    await unlockAudio();
    setActiveJob(job);
    setTab('voice');
    await sendMessage(
      `Brief me fast. Pulling up to ${job.customer_name}${job.address ? ` at ${job.address}` : ''}${job.notes ? `. Notes: ${job.notes}` : ''}.`,
      messages, doctrine, job
    );
  };

  const clearJob = () => {
    setActiveJob(null);
    setMessages([{ role: 'assistant', content: `Job cleared. Tell me what you are walking into or select a new job.` }]);
  };

  if (showLogin) {
    return (
      <SafeAreaView style={[styles.container, { justifyContent: 'center', padding: 24 }]}>
        <StatusBar barStyle="light-content" backgroundColor={COLORS.bg} />
        <TouchableOpacity onPress={() => setTab("voice")}><Text style={styles.logo}>Remy<Text style={{ color: COLORS.orange }}>.</Text></Text></TouchableOpacity>
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

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => setTab("voice")}><Text style={styles.logo}>Remy<Text style={{ color: COLORS.orange }}>.</Text></Text></TouchableOpacity>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {isSpeaking && (
            <TouchableOpacity onPress={stopSpeaking}>
              <Text style={[styles.statusText, { color: COLORS.green }]}>Speaking (stop)</Text>
            </TouchableOpacity>
          )}
          {isRecording && <Text style={[styles.statusText, { color: COLORS.orange }]}>Listening...</Text>}
          {activeJob && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <View style={styles.jobPill}>
                <Text style={styles.jobPillText} numberOfLines={1}>{activeJob.customer_name}</Text>
              </View>
              <TouchableOpacity onPress={clearJob} style={styles.clearBtn}>
                <Text style={styles.clearBtnText}>x</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>

      {/* Tab Content */}
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
              <Text style={[styles.micBtnText, isRecording && { color: '#fff' }]}>{isRecording ? 'Stop' : 'Mic'}</Text>
            </TouchableOpacity>
            <TextInput
              style={styles.textInput}
              value={input}
              onChangeText={setInput}
              placeholder={isRecording ? 'Listening...' : 'Type or tap mic...'}
              placeholderTextColor={COLORS.textFaint}
              onSubmitEditing={() => sendMessage(input, messages, doctrine, activeJob)}
              onFocus={unlockAudio}
              returnKeyType="send"
              editable={!isRecording}
            />
            <TouchableOpacity style={[styles.sendBtn, (!input.trim() || loading) && styles.sendBtnDisabled]} onPress={() => sendMessage(input, messages, doctrine, activeJob)} disabled={!input.trim() || loading}>
              <Text style={styles.sendBtnText}>Send</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      )}

      {tab === 'jobs' && (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20 }}>
          <Text style={styles.tabTitle}>Active Jobs</Text>
          <Text style={styles.tabSub}>Tap a job to brief with Remy</Text>
          {jobs.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateText}>No active jobs. Add jobs from the web dashboard at remy-nu.vercel.app</Text>
            </View>
          ) : (
            jobs.map(job => (
              <TouchableOpacity key={job.id} style={[styles.jobCard, activeJob?.id === job.id && styles.jobCardActive]} onPress={() => selectJob(job)}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.jobCardName}>{job.customer_name}</Text>
                  {job.address ? <Text style={styles.jobCardAddr}>{job.address}</Text> : null}
                  {job.notes ? <Text style={styles.jobCardNotes} numberOfLines={2}>{job.notes}</Text> : null}
                </View>
                <View style={styles.jobCardBtn}>
                  <Text style={styles.jobCardBtnText}>Brief</Text>
                </View>
              </TouchableOpacity>
            ))
          )}
          <TouchableOpacity style={styles.refreshBtn} onPress={loadData}>
            <Text style={styles.refreshBtnText}>Refresh Jobs</Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      {tab === 'settings' && (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20 }}>
          <Text style={styles.tabTitle}>Settings</Text>
          <View style={styles.settingsCard}>
            <Text style={styles.settingsLabel}>WEB DASHBOARD</Text>
            <Text style={styles.settingsValue}>remy-nu.vercel.app</Text>
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

      {/* Bottom Tab Bar */}
      <View style={styles.tabBar}>
        {(['voice', 'jobs', 'settings'] as Tab[]).map(t => (
          <TouchableOpacity key={t} style={styles.tabBtn} onPress={() => setTab(t)}>
            <Text style={[styles.tabIcon, tab === t && styles.tabIconActive]}>
              {t === 'voice' ? 'MIC' : t === 'jobs' ? 'JOBS' : 'SET'}
            </Text>
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
  jobPill: { backgroundColor: COLORS.orangeDim, borderWidth: 1, borderColor: COLORS.orangeBorder, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4, maxWidth: 120 },
  jobPillText: { color: COLORS.orange, fontSize: 11, fontWeight: '500' },
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
  tabBtn: { flex: 1, alignItems: 'center', paddingVertical: 10 },
  tabIcon: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5, color: COLORS.textFaint, marginBottom: 3 },
  tabIconActive: { color: COLORS.orange },
  tabLabel: { fontSize: 11, color: COLORS.textFaint, fontWeight: '500' },
  tabLabelActive: { color: COLORS.orange },
  tabTitle: { fontSize: 22, fontWeight: '800', color: COLORS.text, marginBottom: 6, letterSpacing: -0.5 },
  tabSub: { fontSize: 13, color: COLORS.textDim, marginBottom: 20, fontWeight: '300' },
  emptyState: { backgroundColor: COLORS.bg2, borderRadius: 12, padding: 24, alignItems: 'center' },
  emptyStateText: { color: COLORS.textFaint, fontSize: 13, textAlign: 'center', lineHeight: 20 },
  jobCard: { backgroundColor: COLORS.bg2, borderWidth: 1, borderColor: COLORS.border, borderRadius: 12, padding: 16, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 12 },
  jobCardActive: { borderColor: COLORS.orangeBorder, backgroundColor: COLORS.orangeDim },
  jobCardName: { fontSize: 15, fontWeight: '600', color: COLORS.text, marginBottom: 3 },
  jobCardAddr: { fontSize: 12, color: COLORS.textDim },
  jobCardNotes: { fontSize: 12, color: COLORS.textFaint, marginTop: 4 },
  jobCardBtn: { backgroundColor: COLORS.orangeDim, borderWidth: 1, borderColor: COLORS.orangeBorder, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  jobCardBtnText: { color: COLORS.orange, fontSize: 13, fontWeight: '600' },
  refreshBtn: { backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, padding: 14, alignItems: 'center', marginTop: 16 },
  refreshBtnText: { color: COLORS.textDim, fontSize: 14, fontWeight: '500' },
  settingsCard: { backgroundColor: COLORS.bg2, borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, padding: 16, marginBottom: 10 },
  settingsLabel: { fontSize: 10, fontWeight: '600', letterSpacing: 1, color: COLORS.textFaint, textTransform: 'uppercase', marginBottom: 6 },
  settingsValue: { fontSize: 14, color: COLORS.text },
  loginInput: { backgroundColor: COLORS.bg2, borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, padding: 14, color: COLORS.text, fontSize: 16, marginBottom: 12 },
  loginBtn: { backgroundColor: COLORS.orange, borderRadius: 10, padding: 15, alignItems: 'center', marginTop: 8 },
  loginBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  loginSub: { color: COLORS.textDim, fontSize: 15, marginBottom: 32, marginTop: 8 },
});
