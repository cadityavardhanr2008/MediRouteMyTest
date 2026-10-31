(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const now = () => new Date().toLocaleString([], {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
  const safe = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const blankEmergencyContacts = () => [
    {name:"",relationship:"",phone:"",consented:false},
    {name:"",relationship:"",phone:"",consented:false}
  ];
  const initialProfile = {name:"",email:"",phone:"",blood:"",emergencyContact:"",emergencyContacts:blankEmergencyContacts(),id:""};
  const cloneInitialProfile = () => ({...initialProfile,emergencyContacts:blankEmergencyContacts()});
  let state = {};
  let journeyCompletionTimer = null;
  let pickupSearchResults = [];
  let nearbyHospitalResults = [];
  let locationLookupSequence = 0;
  let lastAutoLocationAddress = "";
  let lastAutoLocationLabel = "";
  let sharedPollingStop=null, sharedSeenEvents=new Set(), sharedLastRouteRefresh=0, sharedLastPosition=null, sharedCompletionHandled=new Set();
  function resetState(){
    if(journeyCompletionTimer){clearTimeout(journeyCompletionTimer);journeyCompletionTimer=null;}
    state = {loggedIn:false,profile:cloneInitialProfile(),active:null,history:[],notifications:[],nextNotification:1,location:null,locationDraft:null,locationConfirmed:false,wizardStep:1,details:{type:"",description:"",contact:"",blood:""},routeUpdateCount:0};
    pickupSearchResults=[];nearbyHospitalResults=[];
  }
  resetState();
  const titles = {dashboard:"Home",emergency:"Emergency",request:"Request details",tracking:"Track journey",hospital:"Hospital destination",intake:"Intake summary",profile:"My Profile",notifications:"Notifications",history:"Journey history",more:"My Medi Route","help":"Help & information"};
  function toast(title,body,kind="info"){
    const key=`${kind}|${title}|${body}`;
    const area=$("toastArea");
    const existing=[...area.children].find(item=>item.dataset.toastKey===key);
    if(existing)return;
    const el=document.createElement("div");el.className="toast";el.dataset.toastKey=key;
    el.innerHTML=`<div>${kind==="success"?"✓":kind==="error"?"!":"●"}</div><div><strong>${safe(title)}</strong><span>${safe(body)}</span></div>`;
    area.appendChild(el);setTimeout(()=>el.remove(),4200);
  }
  function addNotification(title,body,kind="info",page="request"){
    state.notifications.unshift({id:state.nextNotification++,title,body,time:now(),read:false,kind,page});renderNotificationBits();
  }
  function unreadCount(){return state.notifications.filter(n=>!n.read).length}
  function renderNotificationBits(){
    const n=unreadCount();$("topUnreadDot").classList.toggle("hidden",n===0);const sideUnread=$("sideUnread");if(sideUnread){sideUnread.classList.toggle("hidden",n===0);sideUnread.textContent=n;}
    const recent=state.notifications.slice(0,3);
    $("dashboardNotifications").innerHTML=recent.length?recent.map(n=>`<div class="list-item"><div class="list-icon">${n.kind==="success"?"✓":"♧"}</div><div class="list-copy"><strong>${safe(n.title)} ${n.read?"":'<span class="pill teal">New</span>'}</strong><span>${safe(n.body)} · ${safe(n.time)}</span></div></div>`).join(""):`<div class="empty"><p>No notifications yet.</p></div>`;
    $("notificationList").innerHTML=state.notifications.length?state.notifications.map(n=>`<div class="list-item" style="${n.read?"opacity:.72":""}"><div class="list-icon">${n.kind==="success"?"✓":n.kind==="error"?"!":"♧"}</div><div class="list-copy"><strong>${safe(n.title)} ${n.read?"":'<span class="pill teal">Unread</span>'}</strong><span>${safe(n.body)} · ${safe(n.time)}</span><div class="actions" style="margin-top:9px"><button class="btn outline" data-notif-page="${safe(n.page)}" data-notif-id="${n.id}">View related page</button>${n.read?"":`<button class="btn secondary" data-read-id="${n.id}">Mark read</button>`}</div></div></div>`).join(""):`<div class="empty"><div class="empty-icon">♧</div><h3>You're all caught up</h3><p>Updates about your requests will appear here.</p></div>`;
  }
  function go(page){
    if(!titles[page])page="dashboard";
    document.querySelectorAll(".page").forEach(p=>p.classList.remove("active"));
    $("page-"+page).classList.add("active");
    document.querySelectorAll("[data-page]").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
    $("topTitle").textContent=titles[page];window.scrollTo({top:0,behavior:"smooth"});
    renderPage(page);
    if(page==="emergency")prefillEmergencyProfile();
  }
  function renderPage(page){
    if(page==="dashboard")renderDashboard();
    if(page==="request")renderRequest();
    if(page==="tracking")renderTracking();
    if(page==="hospital")renderHospital();
    if(page==="intake")renderIntake();
    if(page==="profile")renderProfile();
    if(page==="history")renderHistory();
    if(page==="notifications")renderNotificationBits();
    if(page==="more")renderMore();
    if(page==="emergency")renderEmergency();
  }
  function currentStage(){
    if(!state.active)return -1;
    return ({submitted:0,searching:1,assigned:2,approaching:3,at_pickup:4,pickedup:5,enroute:6,arrived:7,completed:8,unavailable:1})[state.active.status]??0;
  }
  function statusLabel(s){return ({submitted:"Request submitted",searching:"Searching for an ambulance",assigned:"Ambulance assigned",approaching:"Ambulance approaching",at_pickup:"Ambulance arrived at pickup",pickedup:"Patient picked up",enroute:"En route to hospital",arrived:"Arrived at hospital",completed:"Journey completed",cancelled:"Request cancelled",unavailable:"No ambulance available"})[s]||"Status unavailable"}
  function statusPill(s){let cls=["completed","arrived"].includes(s)?"green":["unavailable"].includes(s)?"red":["submitted","searching"].includes(s)?"amber":"teal";return `<span class="pill ${cls}">${safe(statusLabel(s))}</span>`}

  function sharedEmergencyToLocal(remote){
    const assignment=remote.assignment||null,loc=remote.ambulanceLocation||assignment?.location||null,dest=remote.destination||null;
    const hospital=dest?{id:dest.hospitalId||dest.id||"",name:dest.hospitalName||dest.name||"Selected hospital",address:dest.address||"",phone:dest.phone||"",coords:dest.coords?{lat:Number(dest.coords.lat),lng:Number(dest.coords.lng)}:null,facilities:dest.facilities||[]}:null;
    const ambulance=assignment?{id:assignment.unit||"Ambulance",label:assignment.unit||"Ambulance",crewId:assignment.crewId,name:assignment.crewName,crewName:assignment.crewName,phone:assignment.phone||"",role:assignment.role||"Ambulance personnel",unit:assignment.unit||"",coords:loc?{lat:Number(loc.lat),lng:Number(loc.lng),accuracy:loc.accuracy,at:loc.at,source:loc.source}:null,startCoords:assignment.location?{lat:Number(assignment.location.lat),lng:Number(assignment.location.lng)}:null}:null;
    const alerts=(remote.contactAlerts||[]).map(x=>({event:x.event,time:new Date(x.at).toLocaleString(),status:x.deliveryStatus==="preview_only"?"prepared-not-sent":x.deliveryStatus,recipientCount:(x.recipients||[]).length,message:x.message,deliveryNote:x.deliveryNote}));
    return {id:remote.id,created:remote.createdAt?new Date(remote.createdAt).toLocaleString():now(),updated:remote.updatedAt?new Date(remote.updatedAt).toLocaleString():now(),location:{address:remote.pickupLocation?.address||"Pickup point",coords:remote.pickupLocation?.coords?{lat:Number(remote.pickupLocation.coords.lat),lng:Number(remote.pickupLocation.coords.lng)}:null,source:remote.pickupLocation?.source||"shared"},details:remote.details||{},status:remote.status,ambulance,hospital,eta:remote.route?.etaMinutes??assignment?.etaMinutes??null,distance:remote.route?.distanceKm??assignment?.distanceKm??null,routeData:null,routeMode:null,routeError:"",routeVersion:1,lastLocationUpdate:loc?.at?new Date(loc.at).toLocaleString():now(),contactAlert:{events:alerts,recipients:remote.contactRecipients||[],latest:alerts[0]||null},timeline:remote.timeline||[],shared:true,sharedStatus:remote.status,remoteUpdatedAt:remote.updatedAt,patientAssessment:remote.patientAssessment||null};
  }
  function pointDistanceKm(a,b){
    if(!a||!b)return Infinity;const rad=n=>n*Math.PI/180,dLat=rad(b.lat-a.lat),dLng=rad(b.lng-a.lng);
    const x=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLng/2)**2;
    return 6371*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
  }
  function addSharedTimelineNotifications(active,remote){
    (remote.timeline||[]).slice().reverse().forEach(event=>{
      if(!event.id||sharedSeenEvents.has(event.id))return;
      sharedSeenEvents.add(event.id);
      if(event.actor==="patient"&&/request submitted/i.test(event.message))return;
      addNotification(event.message,"By "+(event.actor||"system")+" · "+new Date(event.at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}),event.kind||"info",event.message.toLowerCase().includes("hospital")?"hospital":"tracking");
    });
  }
  function hydrateSharedHistory(emergencies){
    (emergencies||[]).filter(e=>e&&e.status==="completed").forEach(e=>{
      if(state.history.some(row=>row.id===e.id))return;
      state.history.push({
        id:e.id,
        date:e.createdAt?new Date(e.createdAt).toLocaleString():now(),
        type:e.details?.type||"Emergency",
        status:"Completed",
        hospital:e.destination?.hospitalName||e.destination?.name||"Not recorded"
      });
    });
    state.history.sort((a,b)=>String(b.date||"").localeCompare(String(a.date||"")));
  }
  function syncPatientSnapshot(snapshot){
    if(snapshot?.sessionExpired){if(sharedPollingStop)sharedPollingStop();sharedPollingStop=null;toast("Session expired","Please sign in again to continue.","error");return;}
    if(snapshot?.role!=="patient")return;
    hydrateSharedHistory(snapshot.emergencies||[]);
    if(snapshot.profile){
      const profile=snapshot.profile;
      state.profile={...state.profile,...profile,emergencyContacts:getEmergencyContacts(profile)};
      if(state.loggedIn&&!document.querySelector("#page-profile.active"))renderDashboard();
    }
    const remote=(snapshot.emergencies||[]).sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||"")))[0];
    if(!remote)return;
    if(remote.status==="completed"&&sharedCompletionHandled.has(remote.id)&&(!state.active||state.active.id!==remote.id))return;
    if(!state.active||state.active.id!==remote.id){
      state.active=sharedEmergencyToLocal(remote);
      state.location=state.active.location;state.locationConfirmed=true;
      state.details=state.active.details;
      addNotification("Shared emergency request",`Request ${remote.id} is now synchronised with the ambulance team.`,"success","request");
    }
    const previous=state.active;const previousStatus=previous.status;const oldCoords=previous.ambulance?.coords;
    const next=sharedEmergencyToLocal(remote);
    const moved=!!(oldCoords&&next.ambulance?.coords&&pointDistanceKm(oldCoords,next.ambulance.coords)>0.06);
    const positionChanged=!!(next.ambulance?.coords&&(!oldCoords||Math.abs(oldCoords.lat-next.ambulance.coords.lat)>0.00001||Math.abs(oldCoords.lng-next.ambulance.coords.lng)>0.00001));
    const oldRoute=previous.routeData,oldMode=previous.routeMode,oldRouteError=previous.routeError;
    Object.assign(previous,next);
    if(!positionChanged){previous.routeData=oldRoute;previous.routeMode=oldMode;previous.routeError=oldRouteError;}
    else if(oldRoute?.primary){previous.routeData=oldRoute;previous.routeMode=oldMode;previous.routeError=oldRouteError;}
    state.location=previous.location;state.locationConfirmed=true;
    addSharedTimelineNotifications(previous,remote);
    if(positionChanged){
      previous.lastLocationUpdate=next.lastLocationUpdate;
      if(moved&&Date.now()-sharedLastRouteRefresh>7000){
        sharedLastRouteRefresh=Date.now();
        refreshActiveRouteAutomatically().then(()=>{if(document.querySelector("#page-tracking.active"))renderTracking();});
      }else if(document.querySelector("#page-tracking.active"))renderTracking();
    }
    if(remote.status!==previousStatus){
      previous.updated=next.updated;
      if(["assigned","approaching","at_pickup","pickedup","enroute","arrived","cancelled"].includes(remote.status)){
        renderDashboard();renderRequest();
        if(["assigned","approaching","at_pickup","enroute"].includes(remote.status)&&activeRouteEndpoints(previous)){
          previous.routeData=null;previous.routeMode=null;previous.routeError="";
          loadActiveRoute().then(()=>{if(document.querySelector("#page-tracking.active"))renderTracking();});
        }
        if(document.querySelector("#page-tracking.active"))renderTracking();
        if(document.querySelector("#page-hospital.active"))renderHospital();
      }
    }
    if(remote.status==="completed"&&!sharedCompletionHandled.has(remote.id)){
      sharedCompletionHandled.add(remote.id);
      const exists=state.history.some(h=>h.id===remote.id);
      if(!exists)state.history.unshift({id:remote.id,date:previous.created,type:previous.details?.type||"Emergency",status:"Completed",hospital:previous.hospital?.name||"Not recorded"});
      addNotification("Patient handover completed","The ambulance crew confirmed hospital handover. Your journey is saved in History.","success","history");
      previous.status="completed";renderTracking();renderRequest();renderDashboard();
      if(journeyCompletionTimer)clearTimeout(journeyCompletionTimer);
      journeyCompletionTimer=setTimeout(()=>finalizeJourneyAndReturnHome(remote.id),2200);
    }
    if(remote.status==="unavailable"){
      previous.status="unavailable";renderDashboard();renderRequest();
    }
  }
  function startSharedPolling(){
    if(sharedPollingStop)sharedPollingStop();
    sharedPollingStop=window.MediRouteSync?.startPolling(syncPatientSnapshot,1200)||null;
  }
  function mapSharedEmergency(remote){return sharedEmergencyToLocal(remote);}
  function getEmergencyContacts(profile=state.profile){
    const saved=Array.isArray(profile?.emergencyContacts)?profile.emergencyContacts:[];
    return [0,1].map(i=>({name:String(saved[i]?.name||""),relationship:String(saved[i]?.relationship||""),phone:String(saved[i]?.phone||""),consented:!!saved[i]?.consented}));
  }
  function optedInEmergencyContacts(profile=state.profile){
    return getEmergencyContacts(profile).filter(c=>c.name.trim()&&c.phone.trim()&&c.consented);
  }
  function mapLink(point){return point&&Number.isFinite(Number(point.lat))&&Number.isFinite(Number(point.lng))?`https://maps.google.com/?q=${Number(point.lat)},${Number(point.lng)}`:"Not available"}
  function buildEmergencyAlertMessage(a,eventName){
    const pickup=a.location?.coords?`${a.location.address}\nPickup map: ${mapLink(a.location.coords)}\nPickup coordinates: ${Number(a.location.coords.lat).toFixed(6)}, ${Number(a.location.coords.lng).toFixed(6)}`:`${a.location?.address||"Not available"}\nPickup coordinates: unavailable`;
    const vehicle=a.ambulance?.coords?`\nAmbulance current position: ${Number(a.ambulance.coords.lat).toFixed(6)}, ${Number(a.ambulance.coords.lng).toFixed(6)}\nVehicle map: ${mapLink(a.ambulance.coords)}`:"\nAmbulance: waiting for assignment";
    const hospital=a.hospital?.coords?`${a.hospital.name}\n${a.hospital.address||""}\nHospital map: ${mapLink(a.hospital.coords)}`:"Not yet selected";
    return ["MEDIROUTE · EMERGENCY UPDATE",`Update: ${eventName}`,`Patient: ${state.profile.name}`,`Request: ${a.id}`,`Emergency: ${a.details?.type||"Not specified"}`,`Description: ${a.details?.description||"Not provided"}`,`Patient phone: ${a.details?.contact||state.profile.phone||"Not provided"}`,`Pickup location: ${pickup}`,`Ambulance: ${a.ambulance?.id||"Not assigned"}${vehicle}`,`Current status: ${statusLabel(a.status)}`,`Hospital destination: ${hospital}`,`Updated: ${new Date().toLocaleString()}`,"Please contact the patient and go to the relevant location if it is safe to do so. Do not delay contacting emergency services."].join("\n\n");
  }
  function recordEmergencyContactAlert(a,eventName){
    if(!a)return;
    const recipients=optedInEmergencyContacts();
    if(!a.contactAlert)a.contactAlert={events:[],recipients:[]};
    a.contactAlert.recipients=recipients.map(c=>({name:c.name,relationship:c.relationship,phone:c.phone}));
    const entry={event:eventName,time:now(),status:recipients.length?"prepared-not-sent":"no-consented-contacts",recipientCount:recipients.length,message:buildEmergencyAlertMessage(a,eventName)};
    a.contactAlert.events.push(entry);a.contactAlert.latest=entry;
    return entry;
  }
  function contactAlertCardMarkup(a){
    const recipients=a.contactAlert?.recipients||optedInEmergencyContacts();
    const latest=a.contactAlert?.latest;
    const recipientsMarkup=recipients.length?recipients.map(c=>`<div class="contact-alert-recipient"><span class="contact-alert-avatar">${safe((c.name||"C").charAt(0).toUpperCase())}</span><span><strong>${safe(c.name)}</strong><small>${safe(c.relationship||"Emergency contact")} · ${safe(c.phone)}</small></span><span class="pill teal">Opted in</span></div>`).join(""):`<p class="muted small">No contacts have opted in yet. Add trusted people in My Profile and confirm that they have agreed to receive alerts.</p>`;
    return `<div class="card contact-alert-card"><div class="split-head"><div><h3>Emergency contact updates</h3><p class="muted small">A prepared alert can include the pickup point, current vehicle position, request status and selected hospital.</p></div><span class="pill amber">Not sent</span></div><div class="contact-alert-recipients">${recipientsMarkup}</div><div class="notice warn small" style="margin-top:12px">${recipients.length?`Latest update: <b>${safe(latest?.event||"Request created")}</b>. This alert preview is stored by the shared server but is <b>not sent</b>; no SMS/WhatsApp provider is connected.`:"Contact alerts are not configured for this profile."}</div>${recipients.length&&latest?`<button type="button" id="previewContactAlert" class="btn outline full" style="margin-top:12px">Preview latest contact message</button>`:""}</div>`;
  }
  function showContactAlertPreview(a){
    const latest=a?.contactAlert?.latest;if(!latest)return;
    const recipientLines=(a.contactAlert.recipients||[]).map(c=>`${c.name} · ${c.phone}`).join("\n");
    $("modalRoot").innerHTML=`<div class="modal-backdrop" role="presentation"><div class="modal contact-alert-modal" role="dialog" aria-modal="true" aria-labelledby="contactAlertPreviewTitle"><div class="split-head"><h2 id="contactAlertPreviewTitle">Emergency alert preview</h2><span class="pill amber">Not sent</span></div><p class="muted small">Prepared for: ${safe(recipientLines)}</p><pre class="contact-alert-message">${safe(latest.message)}</pre><div class="notice warn small">This message has not been sent to anyone. Real delivery requires a secure authenticated backend and a configured messaging provider.</div><div class="modal-actions"><button type="button" id="closeContactAlertPreview" class="btn primary">Close</button></div></div></div>`;
    $("closeContactAlertPreview").onclick=()=>$("modalRoot").innerHTML="";
  }
  function renderDashboard(){
    $("welcomeTitle").textContent=`Good to see you, ${state.profile.name.split(" ")[0]}`;
    $("sideName").textContent=state.profile.name;$("sideAvatar").textContent=state.profile.name.charAt(0).toUpperCase()||"P";
    $("dashPatientId").textContent=state.profile.id;$("dashName").textContent=state.profile.name;$("dashEmail").textContent=state.profile.email;$("dashBlood").textContent=state.profile.blood||"Not provided";
    const savedContacts=getEmergencyContacts().filter(c=>c.name.trim()&&c.phone.trim()).length;
    const filled=[state.profile.name,state.profile.email,state.profile.phone,state.profile.blood,savedContacts>0].filter(Boolean).length;
    const percent=Math.round(filled/5*100);$("profileComplete").textContent=percent+"%";$("historyCount").textContent=state.history.length;
    $("dashboardIdle").classList.toggle("hidden",!!state.active);$("activeEmergencyBlock").classList.toggle("hidden",!state.active);
    if(state.active){
      const a=state.active;
      const etaLabel=["assigned","approaching"].includes(a.status)?"ETA TO PICKUP":["pickedup","enroute"].includes(a.status)?"ETA TO HOSPITAL":"ESTIMATED ARRIVAL";
      const etaText=a.eta!==null&&a.eta!==undefined?`${a.eta} min`:"—";
      const destinationNote=a.hospital?.coords?"Selected hospital destination":"Destination pending";
      const crewMarkup=a.ambulance?`<div class="card section-gap crew-assignment-summary" style="box-shadow:none"><div class="card-head"><div><h3>Assigned ambulance</h3><p class="muted small">Crew details are taken from the account that accepted this request.</p></div><span class="pill green">Assigned</span></div><div class="grid three"><div class="metric"><div class="metric-label">AMBULANCE UNIT</div><div class="metric-value" style="font-size:18px">${safe(a.ambulance.unit||a.ambulance.id)}</div></div><div class="metric"><div class="metric-label">CREW MEMBER</div><div class="metric-value" style="font-size:17px">${safe(a.ambulance.crewName||a.ambulance.name||"Assigned crew")}</div><div class="metric-foot">${safe(a.ambulance.role||"Ambulance personnel")}</div></div><div class="metric"><div class="metric-label">CREW CONTACT</div><div class="metric-value" style="font-size:17px">${a.ambulance.phone?`<a href="tel:${safe(a.ambulance.phone)}">${safe(a.ambulance.phone)}</a>`:"Not provided by crew"}</div><div class="metric-foot">Crew ID: ${safe(a.ambulance.crewId||"Not provided")}</div></div></div></div>`:"";
      $("activeEmergencyBlock").innerHTML=`<div class="card section-gap"><div class="split-head"><div><span class="eyebrow">${"Active emergency request"}</span><h2 style="margin-top:5px">${safe(a.id)}</h2></div>${statusPill(a.status)}</div><div class="grid three"><div class="metric"><div class="metric-label">CURRENT STATUS</div><div class="metric-value" style="font-size:18px">${safe(statusLabel(a.status))}</div><div class="metric-foot">Updated ${safe(a.updated)}</div></div><div class="metric"><div class="metric-label">${safe(etaLabel)}</div><div class="metric-value">${safe(etaText)}</div><div class="metric-foot">${a.eta!==null&&a.eta!==undefined?"OSRM road estimate":"Not available yet"}</div></div><div class="metric"><div class="metric-label">DESTINATION</div><div class="metric-value" style="font-size:16px">${safe(a.hospital?.name||"Pending")}</div><div class="metric-foot">${safe(destinationNote)}</div></div></div>${crewMarkup}<div class="actions"><button class="btn primary" data-goto="tracking">Open journey tracking →</button><button class="btn outline" data-goto="request">Request details</button>${a.status==="completed"?'<button class="btn secondary" id="newEmergencyBtn">Request another ambulance</button>':""}</div></div>`;
      $("activeEmergencyBlock").querySelector("#newEmergencyBtn")?.addEventListener("click",()=>startNewEmergency());
    }
    $("dashboardHistory").innerHTML=historyRows(state.history.slice(0,3));
    renderNotificationBits();
  }
  function historyRows(items){
    if(!items.length)return `<div class="empty"><div class="empty-icon">◷</div><h3>No journeys yet</h3><p>Completed journeys will appear here.</p><button class="btn primary" data-goto="emergency">Request an ambulance</button></div>`;
    return `<div class="table-wrap"><table><thead><tr><th>Request reference</th><th>Date</th><th>Journey type</th><th>Status</th><th>Destination</th></tr></thead><tbody>${items.map(x=>`<tr><td><strong>${safe(x.id)}</strong></td><td>${safe(x.date)}</td><td>${safe(x.type||"Emergency")}</td><td><span class="pill green">${safe(x.status)}</span></td><td>${safe(x.hospital||"Not assigned")}</td></tr>`).join("")}</tbody></table></div>`;
  }
  function renderMore(){
    $("moreName").textContent=state.profile.name;
    $("moreEmail").textContent=state.profile.email;
    $("moreNotifications").innerHTML=state.notifications.length?state.notifications.slice(0,2).map(n=>`<div class="list-item"><div class="list-copy"><strong>${safe(n.title)}</strong><span>${safe(n.time)}</span></div></div>`).join(""):`<p class="muted small">No notifications yet.</p>`;
    $("moreRequestSummary").innerHTML=state.active?`<div class="list-item"><div class="list-copy"><strong>${safe(state.active.id)}</strong><span>${safe(statusLabel(state.active.status))}</span></div>${statusPill(state.active.status)}</div>`:`<p class="muted small">No active request. Start an emergency request if you want to explore the journey flow.</p>`;
    $("moreHistorySummary").innerHTML=state.history.length?`<p class="muted small">${state.history.length} journey record${state.history.length===1?"":"s"} available.</p>`:`<p class="muted small">No journey records yet.</p>`;
  }
  function renderPickupCoordinates(point){
    const hasPoint=!!point&&Number.isFinite(Number(point.lat))&&Number.isFinite(Number(point.lng));
    const set=(id,value)=>{const el=$(id);if(el)el.textContent=value;};
    if(!hasPoint){
      set("pickupLatitude","—");set("pickupLongitude","—");
      set("pickupAccuracy","Not available");set("pickupLocationSource","Not detected");
      set("pickupCoordinateHint","Use Detect my location or select a point on the map.");
      set("pickupCoordinateNote","Coordinates come directly from the browser's device-location result or from the point you select on the map. No IP-based location fallback is used.");
      return;
    }
    const lat=Number(point.lat),lng=Number(point.lng);
    const accuracy=Number(point.accuracy);
    const source=String(point.source||"map-pin");
    const sourceLabel=source==="gps"?"Device location (macOS / Chrome)":source==="nominatim"?"OpenStreetMap place search":source==="map-pin"?"Selected on map":"Selected location";
    set("pickupLatitude",lat.toFixed(6));set("pickupLongitude",lng.toFixed(6));
    set("pickupAccuracy",Number.isFinite(accuracy)&&accuracy>0?`±${Math.round(accuracy)} m`:(source==="gps"?"Not reported by device":"Not available"));
    set("pickupLocationSource",sourceLabel);
    set("pickupCoordinateHint",source==="gps"?"Device location received. Check its accuracy and confirm the pickup point.":"Selected map coordinates. Confirm that the pin is at the correct pickup point.");
    set("pickupCoordinateNote",source==="gps"?"These are the coordinates returned by Chrome's device-location API using macOS Location Services. No IP-based estimate is used.":"The displayed coordinates are the exact map point selected. Drag the marker or tap the map to adjust it.");
  }

  function renderEmergency(){
    const existing=!!state.active&&!['completed','cancelled'].includes(state.active.status);
    $("emergencyExisting").classList.toggle("hidden",!existing);$("emergencyWizard").classList.toggle("hidden",existing);
    if(existing){$("emergencyExisting").innerHTML=`<div class="empty"><div class="empty-icon">✚</div><h2>You already have an active ${"emergency"} request</h2><p>Continue to your current request rather than creating another active journey.</p><p>${statusPill(state.active.status)}</p><div class="actions" style="justify-content:center"><button class="btn primary" data-goto="request">View request</button><button class="btn outline" data-goto="tracking">Open tracking</button></div></div>`;return}
    setWizardStep(state.wizardStep);
    if(state.locationConfirmed&&state.location){
      $("locationConfirmed").classList.remove("hidden");
      $("confirmedLocationText").textContent=state.location.address;
      $("confirmedCoords").textContent=state.location.coords?`Coordinates: ${state.location.coords.lat.toFixed(5)}, ${state.location.coords.lng.toFixed(5)} · ${state.location.source||"map point"}`:"Manual address · map coordinates not available";
      $("nextLocation").disabled=false;
    } else {
      $("locationConfirmed").classList.add("hidden");
      $("nextLocation").disabled=true;
    }
    const point=state.locationDraft?.coords||state.location?.coords||null;
    renderPickupCoordinates(point?{...point,source:state.locationDraft?.source||state.location?.source,accuracy:state.locationDraft?.accuracy}:null);
    if(window.MediRouteMaps){
      const mapPoint=point?{...point,accuracy:state.locationDraft?.accuracy??state.location?.accuracy}:null;
      const ready=window.MediRouteMaps.initPickupMap(onPickupMapPicked,mapPoint);
      if(!ready&&$("pickupMapStatus"))$("pickupMapStatus").textContent="The map library could not load. You can still enter a pickup address manually; reload the page to retry the map.";
    } else if($("pickupMapStatus")) {
      $("pickupMapStatus").textContent="Map library is not available. You can still enter a pickup address manually.";
    }
  }
  function onPickupMapPicked(point){
    if(!point||!Number.isFinite(Number(point.lat))||!Number.isFinite(Number(point.lng)))return;
    const lat=Number(point.lat),lng=Number(point.lng);
    const inputAddressBeforeLookup=$("manualAddress").value;
    const inputLabelBeforeLookup=$("locationLabel").value;
    state.locationDraft={
      ...(state.locationDraft||{}),
      address:inputAddressBeforeLookup.trim()||state.locationDraft?.address||`Selected map point (${lat.toFixed(5)}, ${lng.toFixed(5)})`,
      coords:{lat,lng},
      source:point.source||"map-pin",
      ...(Number.isFinite(Number(point.accuracy))?{accuracy:Number(point.accuracy)}:{}),
      ...(Number.isFinite(Number(point.timestamp))?{timestamp:Number(point.timestamp)}:{})
    };
    state.locationConfirmed=false;
    renderPickupCoordinates({lat,lng,source:point.source||"map-pin",accuracy:point.accuracy});
    $("locationConfirmed").classList.add("hidden");
    $("nextLocation").disabled=true;
    const lookupId=++locationLookupSequence;
    const gpsAccuracy=Number.isFinite(Number(point.accuracy))?` · reported accuracy ±${Math.round(Number(point.accuracy))} m`:"";
    $("locationFeedback").textContent=`Map centred on ${lat.toFixed(5)}, ${lng.toFixed(5)}${gpsAccuracy}. Looking up the nearest readable address…`;

    // Convert GPS/map coordinates into readable address fields. This is a
    // reverse-geocoding request, so it is queued under Nominatim's rate limit.
    if(window.MediRouteMaps?.reverseGeocode){
      window.MediRouteMaps.reverseGeocode({lat,lng}).then(result=>{
        if(lookupId!==locationLookupSequence)return;
        const current=state.locationDraft?.coords;
        if(!current||Math.abs(current.lat-lat)>0.00001||Math.abs(current.lng-lng)>0.00001)return;
        const address=result.displayName;
        const currentAddress=$("manualAddress").value;
        if(currentAddress===inputAddressBeforeLookup||currentAddress===lastAutoLocationAddress||!currentAddress.trim()){
          $("manualAddress").value=address;
          lastAutoLocationAddress=address;
        }
        const currentLabel=$("locationLabel").value;
        if(result.locality&&(currentLabel===inputLabelBeforeLookup||currentLabel===lastAutoLocationLabel||!currentLabel.trim())){
          $("locationLabel").value=result.locality;
          lastAutoLocationLabel=result.locality;
        }
        state.locationDraft.address=address;
        $("locationFeedback").textContent=`Address found: ${address}. The map pin is centred on the selected point. Confirm only after checking the pickup point.`;
      }).catch(error=>{
        if(lookupId!==locationLookupSequence)return;
        $("locationFeedback").textContent=`Map point selected (${lat.toFixed(5)}, ${lng.toFixed(5)}), but the address lookup failed. ${error.message||"Enter the address manually if needed."}`;
      });
    } else {
      $("locationFeedback").textContent=`Pickup point selected at ${lat.toFixed(5)}, ${lng.toFixed(5)}. Enter an address manually and confirm this point.`;
    }
  }
  function setWizardStep(step){
    state.wizardStep=step;
    [1,2,3].forEach(n=>$("wizardStep"+n).classList.toggle("hidden",n!==step));
    document.querySelectorAll("[data-step-ind]").forEach(el=>{const n=Number(el.dataset.stepInd);el.classList.toggle("current",n===step);el.classList.toggle("done",n<step);el.querySelector(".step-circle").textContent=n<step?"✓":String(n)});
    if(step===1&&window.MediRouteMaps){requestAnimationFrame(()=>{const point=state.locationDraft?.coords||state.location?.coords||null;const mapPoint=point?{...point,accuracy:state.locationDraft?.accuracy??state.location?.accuracy}:null;window.MediRouteMaps.initPickupMap(onPickupMapPicked,mapPoint);});}
  }
  function confirmManual(){
    const address=$("manualAddress").value.trim();
    const draft=state.locationDraft;
    const hasPoint=!!draft?.coords;
    const readableAddress=address.trim()||(draft?.address||"");
    if(!readableAddress.trim()){toast("Pickup address needed","Enter an address or select a public map result so the crew can identify the pickup point.","error");$("manualAddress").focus();return}
    if(!hasPoint){
      const message="An address by itself cannot be used for nearest-ambulance dispatch. Search for the place, detect your location, or tap/drag the map to set its coordinates.";
      $("locationFeedback").textContent=message;
      toast("Map point required",message,"error");
      return;
    }
    const label=$("locationLabel").value.trim();
    const baseAddress=readableAddress;
    state.location={
      address:(label?label+" — ":"")+baseAddress,
      coords:{...draft.coords},
      source:draft.source||"map-pin",
      ...(Number.isFinite(Number(draft.accuracy))?{accuracy:Number(draft.accuracy)}:{})
    };
    state.locationDraft=null;state.locationConfirmed=true;
    $("locationFeedback").textContent="Pickup address and map coordinates confirmed. The system can now find the nearest available ambulance.";
    renderEmergency();toast("Location confirmed","Your pickup location is selected. It will be shared with the crew when you submit the request.","success");
  }
  $("confirmLocation").addEventListener("click",confirmManual);
  $("clearPickupPin").addEventListener("click",()=>{
    state.locationDraft=null;state.location=null;state.locationConfirmed=false;
    window.MediRouteMaps?.clearPickupMarker();
    renderPickupCoordinates(null);
    $("locationConfirmed").classList.add("hidden");$("nextLocation").disabled=true;
    $("locationFeedback").textContent="Map pin cleared. Search for a public place, detect your device location, or tap/drag the map to set a new coordinate before confirming.";
    toast("Map pin cleared","You can now use only the manually entered address.","info");
  });
  $("searchLocationBtn").addEventListener("click",async()=>{
    const query=$("locationSearchQuery").value.trim();
    const button=$("searchLocationBtn"),status=$("pickupSearchStatus"),resultsRoot=$("pickupSearchResults");
    if(!window.MediRouteMaps){status.textContent="Map services are unavailable. Reload the page or enter the address manually.";return}
    if(query.length<3){status.textContent="Enter at least 3 characters for a public place or landmark search.";return}
    button.disabled=true;button.textContent="Searching…";status.textContent="Searching OpenStreetMap place data…";resultsRoot.innerHTML="";
    try{
      pickupSearchResults=await window.MediRouteMaps.searchPlaces(query,{limit:6});
      if(!pickupSearchResults.length){status.textContent="No matching places found. Try a nearby landmark, area or station name.";return}
      status.textContent=`${pickupSearchResults.length} result${pickupSearchResults.length===1?"":"s"}. Select the correct pickup point.`;
      resultsRoot.innerHTML=pickupSearchResults.map((item,index)=>`<div class="list-item"><div class="list-icon">⌖</div><div class="list-copy"><strong>${safe(item.name)}</strong><span>${safe(item.displayName)}</span><div class="actions" style="margin-top:7px"><button class="btn outline" type="button" data-pickup-result="${index}">Use this point</button></div></div></div>`).join("");
    }catch(error){status.textContent=error.message||"Place search failed. Try again or enter a manual address.";}
    finally{button.disabled=false;button.textContent="Search map";}
  });
  function requestPositionOnce(options){
    return new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,reject,options));
  }
  function requestPositionFromWatch(timeoutMs=15000,enableHighAccuracy=true){
    return new Promise((resolve,reject)=>{
      if(typeof navigator.geolocation.watchPosition!=="function"){
        reject(Object.assign(new Error("Continuous location updates are not supported by this browser."),{code:"UNSUPPORTED"}));
        return;
      }
      let watchId=null,settled=false,lastError=null;
      const finish=(callback,value)=>{
        if(settled)return;
        settled=true;
        if(watchId!==null)navigator.geolocation.clearWatch(watchId);
        clearTimeout(timer);callback(value);
      };
      const timer=setTimeout(()=>finish(reject,lastError||Object.assign(new Error("No device-location update was received."),{code:3})),timeoutMs);
      watchId=navigator.geolocation.watchPosition(
        position=>finish(resolve,position),
        error=>{lastError=error;finish(reject,error);},
        {enableHighAccuracy,timeout:timeoutMs,maximumAge:0}
      );
    });
  }
  async function browserPermissionState(){
    try{
      if(!navigator.permissions?.query)return "unknown";
      const result=await navigator.permissions.query({name:"geolocation"});
      return result.state||"unknown";
    }catch{return "unknown";}
  }
  async function requestBrowserPosition(onProgress=()=>{}){
    if(!window.isSecureContext){
      throw Object.assign(new Error("Location access requires HTTPS or localhost. Open this site through http://127.0.0.1 or an HTTPS address, not file://."),{code:"INSECURE_CONTEXT"});
    }
    if(!navigator.geolocation){
      throw Object.assign(new Error("This browser does not expose device-location services. Use a current Chrome or Safari browser, or select the pickup point on the map."),{code:"UNSUPPORTED"});
    }
    const permission=await browserPermissionState();
    if(permission==="denied")throw Object.assign(new Error("Location permission is blocked for this site. Allow Location for 127.0.0.1 in Chrome site settings, then retry."),{code:1});

    let lastError=null;
    onProgress(0);
    try{
      // Always request a fresh device location. Do not reuse stale cached fixes
      // and do not estimate a location from the public IP address.
      return await requestPositionOnce({enableHighAccuracy:true,timeout:20000,maximumAge:0});
    }catch(error){lastError=error;if(error?.code===1)throw error;}
    onProgress(1);
    try{
      // macOS may take a moment to resolve the browser's location from nearby
      // Wi-Fi networks. A short watch keeps the request alive for a fresh fix.
      return await requestPositionFromWatch(15000,true);
    }catch(error){lastError=error;if(error?.code===1)throw error;}
    onProgress(2);
    try{
      // Some platform providers return a fix only when high accuracy is not
      // requested. This is still the browser/macOS Location Services result.
      return await requestPositionOnce({enableHighAccuracy:false,timeout:12000,maximumAge:0});
    }catch(error){if(error?.code===1)throw error;lastError=error||lastError;}
    throw lastError||Object.assign(new Error("macOS and Chrome did not return a device location."),{code:2});
  }
  function locationErrorMessage(error,permissionState="unknown"){
    if(error?.code==="INSECURE_CONTEXT"||error?.code==="UNSUPPORTED")return error.message;
    if(error?.code===1||permissionState==="denied")return "Location permission is blocked. In Chrome, open the site controls beside the address, set Location to Allow, and retry. Also make sure Location Services is enabled for Google Chrome in macOS System Settings → Privacy & Security → Location Services.";
    if(error?.code===2)return "macOS/Chrome could not return a device location. MediRoute has not used your IP address or an approximate fallback. Make sure Wi‑Fi is turned on and Location Services is enabled for Google Chrome in macOS System Settings → Privacy & Security → Location Services. In Chrome site settings for 127.0.0.1, set Location to Allow, then retry.";
    if(error?.code===3)return "The device-location request timed out. Keep Wi‑Fi on, check that macOS Location Services and Chrome's site permission are enabled, then retry.";
    return "The browser could not detect the device location. Check macOS and Chrome location permissions, then retry or select a pickup point on the map.";
  }
  function showLocationFailure(error,permissionState="unknown"){
    const feedback=$("locationFeedback");
    feedback.textContent=locationErrorMessage(error,permissionState);
  }
  let locationRequestInProgress=false;
  $("detectLocation").addEventListener("click",async()=>{
    if(locationRequestInProgress)return;
    locationRequestInProgress=true;
    const btn=$("detectLocation"),feedback=$("locationFeedback");
    btn.disabled=true;btn.textContent="⌖ Detecting location…";
    feedback.textContent="Requesting a fresh location from Chrome and macOS Location Services…";
    try{
      const position=await requestBrowserPosition(stage=>{
        const messages=[
          "Requesting a fresh high-accuracy device location…",
          "Waiting for a fresh macOS location update…",
          "Retrying with the browser's standard device-location setting…"
        ];
        feedback.textContent=messages[stage]||messages[messages.length-1];
      });
      const lat=Number(position.coords.latitude),lng=Number(position.coords.longitude);
      if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)throw Object.assign(new Error("The browser returned invalid coordinates. Select a point on the map instead."),{code:"INVALID_POSITION"});
      const accuracy=Number.isFinite(Number(position.coords.accuracy))?Number(position.coords.accuracy):null;
      const timestamp=Number(position.timestamp)||Date.now();
      state.locationDraft={address:"Current device location",coords:{lat,lng},source:"gps",accuracy,timestamp};
      state.locationConfirmed=false;
      let mapReady=false;
      if(window.MediRouteMaps){
        mapReady=window.MediRouteMaps.initPickupMap(onPickupMapPicked,{lat,lng,accuracy});
        window.MediRouteMaps.updatePickupMap({lat,lng,accuracy});
      }
      onPickupMapPicked({lat,lng,source:"gps",accuracy,timestamp});
      const accuracyText=accuracy!==null?` Browser-reported accuracy: approximately ±${Math.round(accuracy)} m.`:"";
      const ageSeconds=Math.max(0,Math.round((Date.now()-timestamp)/1000));
      const ageText=ageSeconds>60?` Fix age: ${Math.round(ageSeconds/60)} min.`:"";
      const precisionNote=accuracy!==null&&accuracy>1000?" The reported accuracy is low; check the pin carefully.":"";
      renderPickupCoordinates({lat,lng,source:"gps",accuracy});
      feedback.textContent=`Device location received (${lat.toFixed(6)}, ${lng.toFixed(6)}).${accuracyText}${ageText}${precisionNote} ${mapReady?"Check the marker and confirm the pickup location.":"Coordinates were received; verify the pickup point before confirming."}`;
      $("locationConfirmed").classList.add("hidden");$("nextLocation").disabled=true;
      toast("Device location detected","Check the map pin and confirm the pickup point.","success");
    }catch(error){
      if(error?.code==="INVALID_POSITION")feedback.textContent=error.message;
      else {
        const permissionState=await browserPermissionState();
        showLocationFailure(error,permissionState);
      }
      console.warn("MediRoute browser geolocation failed:",{code:error?.code,message:error?.message});
    }finally{
      locationRequestInProgress=false;
      btn.disabled=false;btn.textContent="⌖ Detect my location";
    }
  });
  $("nextLocation").addEventListener("click",()=>{if(!state.locationConfirmed){toast("Confirm location first","Choose a map point or manual address and confirm it before continuing.","error");return}setWizardStep(2)});
  $("backDetails").addEventListener("click",()=>setWizardStep(1));
  $("emergencyDetailsForm").addEventListener("submit",e=>{e.preventDefault();if(!$("emergencyType").value){return}
    state.details={type:$("emergencyType").value,description:$("incidentDescription").value.trim(),contact:$("emergencyContact").value.trim()||state.profile.phone||state.profile.emergencyContact||"",blood:$("emergencyBlood").value||state.profile.blood||"",emergencyContact:getEmergencyContacts().find(c=>c.phone)?.phone||state.profile.emergencyContact||"",emergencyContacts:optedInEmergencyContacts().map(c=>({name:c.name,relationship:c.relationship,phone:c.phone}))};
    $("reviewSummary").innerHTML=`<div class="list-item"><div class="list-icon">⌖</div><div class="list-copy"><strong>Pickup location</strong><span>${safe(state.location.address)}</span></div></div><div class="list-item"><div class="list-icon">✚</div><div class="list-copy"><strong>Emergency category</strong><span>${safe(state.details.type)}</span></div></div><div class="list-item"><div class="list-icon">▤</div><div class="list-copy"><strong>Description</strong><span>${safe(state.details.description||"Not provided")}</span></div></div><div class="list-item"><div class="list-icon">♙</div><div class="list-copy"><strong>Patient information</strong><span>${safe(state.profile.name)} · Blood group: ${safe(state.details.blood||state.profile.blood||"Not provided")}</span></div></div><div class="list-item"><div class="list-icon">☎</div><div class="list-copy"><strong>Contact number</strong><span>${safe(state.details.contact||state.profile.phone||"Not provided")}</span></div></div>${optedInEmergencyContacts().length?`<div class="list-item"><div class="list-icon">♡</div><div class="list-copy"><strong>Emergency contacts opted in</strong><span>${optedInEmergencyContacts().map(c=>safe(c.name)).join(", ")}</span></div></div>`:`<div class="list-item"><div class="list-icon">♡</div><div class="list-copy"><strong>Emergency contact alerts</strong><span>No contacts have opted in. You can add them in My Profile.</span></div></div>`}`;
    $("confirmRequest").checked=false;$("reviewError").textContent="";setWizardStep(3);
  });
  $("backReview").addEventListener("click",()=>setWizardStep(2));
  $("submitEmergency").addEventListener("click",async()=>{
    if(!$("confirmRequest").checked){$("reviewError").textContent="Please confirm the emergency request.";return}
    if(!state.locationConfirmed||!state.location){$("reviewError").textContent="Confirm a pickup location before submitting.";setWizardStep(1);return}
    if(!state.location.coords){$("reviewError").textContent="A map-confirmed coordinate is required for nearest-ambulance assignment. Use Detect my location or select a point on the map.";setWizardStep(1);return}
    const btn=$("submitEmergency");btn.disabled=true;btn.textContent="Submitting request…";
    try{
      const result=await window.MediRouteSync.createEmergency({patient:{name:state.profile.name,phone:state.profile.phone,blood:state.profile.blood},pickupLocation:state.location,details:state.details});
      state.active=sharedEmergencyToLocal(result.emergency);state.active.shared=true;state.location=state.active.location;state.locationConfirmed=true;
      addNotification("Emergency request submitted",`Request ${state.active.id} has been registered with shared dispatch. The nearest eligible available ambulance will be assigned automatically.`,"success","request");
      syncPatientSnapshot({role:"patient",profile:state.profile,emergencies:[result.emergency]});
      go("request");toast("Request submitted","Searching for the nearest available ambulance.","success");
    }catch(error){
      $("reviewError").textContent=error.message||"Could not submit the request. Check the shared server connection.";
      toast("Request not submitted",error.message||"Shared server is unavailable.","error");
    }finally{btn.disabled=false;btn.textContent="✚ Submit request";}
  });

  function activeRouteEndpoints(a){
    if(!a)return null;
    if(["assigned","approaching","at_pickup"].includes(a.status)){
      const origin=a.ambulance?.coords||a.ambulance?.startCoords;
      if(!a.location?.coords||!origin)return null;
      return {origin,destination:a.location.coords,mode:"to-pickup"};
    }
    if(["pickedup","enroute","arrived","completed"].includes(a.status)){
      if(!a.location?.coords||!a.hospital?.coords)return null;
      const origin=a.status==="pickedup"?a.location.coords:(a.ambulance?.coords||a.location.coords);
      return {origin,destination:a.hospital.coords,mode:"to-hospital"};
    }
    return null;
  }
  async function loadActiveRoute(){
    const a=state.active;
    if(!a)return false;
    const endpoints=activeRouteEndpoints(a);
    if(!endpoints){a.routeData=null;a.routeMode=null;a.routeError=a.status==="pickedup"||a.status==="enroute"?"Choose a map-listed destination hospital to calculate the hospital route.":"A confirmed pickup map point is needed for a road route.";return false}
    a.routeLoading=true;
    try{
      if(!window.MediRouteMaps)throw new Error("The map service library did not load. Reload the page to retry.");
      const result=await window.MediRouteMaps.getRoute(endpoints.origin,endpoints.destination);
      a.routeData=result;a.routeMode=endpoints.mode;a.routeError="";
      const route=result.primary;
      // Every route request starts at the vehicle's latest known point, so
      // the returned geometry is already the remaining leg. Reset only the
      // progress along this newly fetched geometry; keep overall trip progress.
      if(a.ambulance){
        a.ambulance.coords={...endpoints.origin};
        a.ambulance.progress=0;
        if(endpoints.mode==="to-pickup")a.ambulance.startCoords={...endpoints.origin};
      }
      a.distance=Math.max(0,Number((route.distance/1000).toFixed(1)));
      a.eta=Math.max(0,Math.ceil(route.duration/60));
      a.lastLocationUpdate=now();
      return true;
    }catch(error){
      a.routeData=null;a.routeMode=endpoints.mode;a.routeError=error.message||"Road route could not be calculated.";a.eta=null;a.distance=null;
      return false;
    }finally{a.routeLoading=false;}
  }
  async function refreshActiveRouteAutomatically(){
    const a=state.active;
    if(!a||!a.ambulance)return false;
    const previous={
      routeData:a.routeData,
      routeMode:a.routeMode,
      routeError:a.routeError,
      eta:a.eta,
      distance:a.distance
    };
    const ok=await loadActiveRoute();
    if(ok){
      a.routeVersion=(a.routeVersion||1)+1;
      a.routeRefreshState="updated";
      return true;
    }
    // If the public routing service is temporarily unavailable, keep the last
    // known route and trim it to the current marker rather than blanking the map.
    if(previous.routeData?.primary){
      a.routeData=previous.routeData;
      a.routeMode=previous.routeMode;
      a.eta=previous.eta;
      a.distance=previous.distance;
      a.routeError="Automatic route refresh is temporarily unavailable. Showing the last available route.";
      a.routeRefreshState="stale";
    }else{
      a.routeRefreshState="unavailable";
    }
    return false;
  }

  function currentAmbulancePoint(a){
    return a?.ambulance?.coords || a?.ambulance?.startCoords || null;
  }
  document.addEventListener("click",e=>{
    const button=e.target.closest("[data-pickup-result]");if(!button)return;
    const item=pickupSearchResults[Number(button.dataset.pickupResult)];if(!item)return;
    state.locationDraft={address:item.displayName,coords:{lat:item.lat,lng:item.lng},source:"nominatim"};state.locationConfirmed=false;
    $("manualAddress").value=item.displayName;
    if(item.locality && (!$("locationLabel").value.trim() || $("locationLabel").value===lastAutoLocationLabel)){
      $("locationLabel").value=item.locality;
      lastAutoLocationLabel=item.locality;
    }
    $("locationFeedback").textContent=`${item.name} selected. The map is centred on this point. Checking the address details…`;
    $("locationConfirmed").classList.add("hidden");$("nextLocation").disabled=true;
    if(window.MediRouteMaps)window.MediRouteMaps.updatePickupMap(item);
    onPickupMapPicked({lat:item.lat,lng:item.lng,source:"nominatim"});
    toast("Pickup point selected","Check the filled address and map pin, then confirm.","success");
  });
  function journeyTimelineMarkup(a){
    const events=(a?.timeline||[]).slice().sort((x,y)=>String(y.at||"").localeCompare(String(x.at||"")));
    if(!events.length)return `<div class="card section-gap"><h3>Journey activity</h3><p class="muted small">Shared journey events will appear here as the ambulance team updates the request.</p></div>`;
    return `<div class="card section-gap"><div class="card-head"><div><h3>Journey activity log</h3><p class="muted small">Milestones recorded by the patient, ambulance crew or shared dispatch service.</p></div><span class="pill teal">${events.length} events</span></div><div class="list">${events.slice(0,20).map(event=>`<div class="list-item"><div class="list-icon">${event.kind==="success"?"✓":"◷"}</div><div class="list-copy"><strong>${safe(event.message||"Journey updated")}</strong><span>${safe(event.actor||"system")} · ${safe(event.at?new Date(event.at).toLocaleString():"Time unavailable")}</span></div></div>`).join("")}</div></div>`;
  }
  function renderRequest(){
    const root=$("requestContent");const a=state.active;
    if(!a){root.innerHTML=`<div class="card empty"><div class="empty-icon">▤</div><h2>No active request</h2><p>When you create an emergency request, its status and details will appear here.</p><button class="btn primary" data-goto="emergency">Report an emergency</button></div>`;return}
    const steps=[["Request submitted",0],["Searching",1],["Ambulance assigned",2],["Ambulance approaching",3],["Patient picked up",4],["En route to hospital",5],["Arrived at hospital",6],["Journey completed",7]];
    const stage=currentStage();
    root.innerHTML=`<div class="card"><div class="split-head"><div><div class="eyebrow">Request reference</div><div class="request-id">${safe(a.id)}</div><p class="muted small" style="margin:5px 0 0">Created ${safe(a.created)}</p></div>${statusPill(a.status)}</div>
      <div class="steps">${steps.map(([label,n],i)=>`<div class="step ${stage>=n&&a.status!=="unavailable"?"done":""} ${stage===n?"current":""}"><div class="step-circle">${stage>n?"✓":i+1}</div>${label}</div>`).join("")}</div>
      ${""}
      <div class="grid equal section-gap"><div class="card" style="box-shadow:none"><h3>Pickup information</h3><div class="info-line"><span>Location</span><strong>${safe(a.location.address)}</strong></div><div class="info-line"><span>Category</span><strong>${safe(a.details.type)}</strong></div><div class="info-line"><span>Description</span><strong>${safe(a.details.description||"Not provided")}</strong></div><div class="info-line"><span>Last status update</span><strong>${safe(a.updated)}</strong></div></div><div class="card" style="box-shadow:none"><h3>Assignment information</h3><div class="info-line"><span>Ambulance unit</span><strong>${safe(a.ambulance?.unit||a.ambulance?.id||"Pending")}</strong></div><div class="info-line"><span>Crew member</span><strong>${safe(a.ambulance?.crewName||a.ambulance?.name||"Pending assignment")}</strong></div><div class="info-line"><span>Crew ID</span><strong>${safe(a.ambulance?.crewId||"Not available")}</strong></div><div class="info-line"><span>Crew role</span><strong>${safe(a.ambulance?.role||"Not assigned")}</strong></div><div class="info-line"><span>Crew contact</span><strong>${safe(a.ambulance?.phone||"Not available")}</strong></div><div class="info-line"><span>${["assigned","approaching"].includes(a.status)?"ETA to pickup":["pickedup","enroute"].includes(a.status)?"ETA to hospital":"Estimated arrival"}</span><strong>${a.eta!==null&&a.eta!==undefined?`${a.eta} min (OSRM road estimate)`:"Not available"}</strong></div><div class="info-line"><span>Destination</span><strong>${safe(a.hospital?.name||"Pending")}</strong></div><div class="info-line"><span>Request status</span><strong>${safe(statusLabel(a.status))}</strong></div></div></div>
      <div class="actions section-gap"><button class="btn primary" data-goto="tracking">Open tracking →</button><button class="btn outline" data-goto="hospital">View hospital destination</button><button class="btn outline" data-goto="intake">Intake preview</button>${a.shared&&['searching','assigned','approaching','at_pickup'].includes(a.status)?'<button class="btn danger" id="cancelSharedRequest">Cancel request</button>':""}${['completed','cancelled'].includes(a.status)?'<button class="btn secondary" data-goto="emergency">Start a new request</button>':""}</div>
      ${a.status==="cancelled"?'<div class="notice warn section-gap">This emergency request was cancelled. You can create a new request from the Emergency page.</div>':""}
      <div class="notice warn section-gap">Assignment and journey updates are synchronised through the shared local MediRoute server. The ambulance location is supplied by the crew device GPS.</div></div>${journeyTimelineMarkup(a)}`;
    $("cancelSharedRequest")?.addEventListener("click",cancelSharedEmergency);
  }
  async function cancelSharedEmergency(){
    const a=state.active;if(!a||!a.shared)return;
    if(!['searching','assigned','approaching','at_pickup'].includes(a.status)){
      toast("Request cannot be cancelled","The patient has already been picked up or the hospital journey has started. Contact the assigned crew if there is a problem.","error");return;
    }
    if(!confirm("Cancel this emergency request? The assigned ambulance will be released if it has not picked you up."))return;
    try{
      const result=await window.MediRouteSync.updateEmergency(a.id,{status:"cancelled",eventMessage:"Patient cancelled the emergency request."});
      state.active=sharedEmergencyToLocal(result.emergency);
      addNotification("Emergency request cancelled","The request was cancelled and the assigned crew was released.","success","request");
      renderRequest();renderDashboard();toast("Request cancelled","The shared dispatch record has been updated.","success");
    }catch(error){toast("Could not cancel request",error.message||"The shared server could not update this request.","error");}
  }
  function routeInstructionsMarkup(a){
    const steps=a?.routeData?.primary?.legs?.[0]?.steps||[];
    if(!steps.length)return `<p class="muted small">${a?.routeError?safe(a.routeError):"Route guidance will appear after a road route is available."}</p>`;
    return `<div class="list">${steps.slice(0,6).map((step,index)=>{
      const manoeuvre=step.maneuver||{};const action=String(manoeuvre.type||"continue").replace(/_/g," ");
      const direction=manoeuvre.modifier?` ${String(manoeuvre.modifier).replace(/_/g," ")}`:"";
      const street=step.name?` onto ${step.name}`:"";
      const metres=Number(step.distance)||0;const distance=metres>=1000?`${(metres/1000).toFixed(1)} km`:`${Math.round(metres)} m`;
      return `<div class="list-item"><div class="list-icon">${index+1}</div><div class="list-copy"><strong>${safe(action+direction+street)}</strong><span>${safe(distance)}</span></div></div>`;
    }).join("")}</div>`;
  }
  function renderTracking(){
    const root=$("trackingContent"),a=state.active;
    if(!a){root.innerHTML=`<div class="card empty"><div class="empty-icon">⌖</div><h2>No active journey to track</h2><p>Create an emergency request to see the tracking experience.</p><button class="btn primary" data-goto="emergency">Start emergency request</button></div>`;return}
    if(a.status==="searching"){
      root.innerHTML=`<div class="card"><div class="empty"><div class="empty-icon">◷</div><h2>Searching for an ambulance</h2><p>The shared dispatch system is checking available ambulance locations and will assign the nearest eligible crew automatically.</p><span class="pill amber">Waiting for assignment</span><div style="margin-top:18px"><button class="btn outline" data-goto="request">View request details</button></div></div></div>`;return;
    }
    if(a.status==="unavailable"){
      root.innerHTML=`<div class="card empty"><div class="empty-icon">!</div><h2>Tracking is not available</h2><p>An ambulance could not be assigned, so there is no vehicle position or route to display.</p><button class="btn primary" data-goto="request">Retry assignment from request details</button></div>`;return;
    }
    const isDone=["arrived","completed"].includes(a.status);
    const isToPickup=["assigned","approaching","at_pickup"].includes(a.status);
    const isHospitalLeg=["pickedup","enroute","arrived","completed"].includes(a.status);
    const routeLabel=isToPickup?"Ambulance to pickup":isHospitalLeg?"Current ambulance location → hospital":"Journey tracking";
    const etaLabel=isToPickup?"Estimated arrival at pickup":"Estimated arrival at hospital";
    const ambulancePoint=currentAmbulancePoint(a);
    const routeExists=!!a.routeData?.primary;
    const currentPointLabel=isToPickup?"Ambulance current location":"Current ambulance location";
    const currentPointText=ambulancePoint&&window.MediRouteMaps?.validPoint(ambulancePoint)?`${Number(ambulancePoint.lat).toFixed(5)}, ${Number(ambulancePoint.lng).toFixed(5)}`:"Position not available";
    const hospitalPointText=a.hospital?.coords?`${Number(a.hospital.coords.lat).toFixed(5)}, ${Number(a.hospital.coords.lng).toFixed(5)}`:"Hospital destination pending";
    const remainingPrimary=routeExists&&(isHospitalLeg||isToPickup)&&window.MediRouteMaps?.routeFromProgress?window.MediRouteMaps.routeFromProgress(a.routeData.primary,a.status==="arrived"||a.status==="completed"?1:(Number(a.ambulance?.progress)||0)):a.routeData?.primary;
    const trackingRoute=(isHospitalLeg||isToPickup)&&remainingPrimary?{primary:remainingPrimary,routes:[remainingPrimary]}:a.routeData;
    const statusMessage=`Live journey updates from ${a.ambulance?.unit||"the assigned ambulance"}. The position is supplied by the ambulance device GPS.`;
    root.innerHTML=`<div class="status-banner"><span class="status-symbol">${isDone?"✓":"⌖"}</span><p><strong>${safe(statusLabel(a.status))}</strong>${safe(statusMessage)}</p></div>
      <div class="route-endpoints-strip">
        <div class="route-endpoint"><span>${isHospitalLeg?"FROM · CURRENT LOCATION":"FROM · AMBULANCE"}</span><strong>${safe(isHospitalLeg?currentPointLabel:"Ambulance current location")}</strong><small>${safe(currentPointText)}</small></div>
        <div class="route-endpoint-arrow" aria-hidden="true">→</div>
        <div class="route-endpoint"><span>TO · DESTINATION</span><strong>${safe(isToPickup?"Patient pickup location":a.hospital?.name||"Hospital not selected")}</strong><small>${safe(isToPickup&&a.location?.coords?`${Number(a.location.coords.lat).toFixed(5)}, ${Number(a.location.coords.lng).toFixed(5)}`:isToPickup?a.location?.address||"Pickup address":hospitalPointText)}</small></div>
      </div>
      <div class="map-layout"><div>
        <div class="map-box"><div class="map-label top">${safe(routeLabel.toUpperCase())}</div><div id="trackingMap" role="application" aria-label="Map showing the current ambulance location and selected destination hospital" style="height:410px;min-height:410px;width:100%"></div></div>
        <div id="trackingMapStatus" class="small muted" role="status" style="margin-top:8px">${routeExists?(isHospitalLeg?"Showing the remaining road route from the current ambulance position to the hospital.":"Showing the remaining road route from the ambulance to the pickup point."):safe(a.routeError||"Waiting for a road route. A pickup map point and a map-selected hospital are needed for routing.")}</div>
        <div class="notice small" id="routeAutoStatus" role="status" style="margin-top:9px">${a.routeRefreshState==="stale"?"Automatic refresh unavailable · showing the last route":a.routeRefreshState==="updated"?"✓ Route and ETA update automatically when the ambulance position changes":"↻ Route and ETA update automatically whenever the ambulance position changes"}</div>
        <div class="map-legend">${isToPickup?'<span><i class="legend-dot" style="background:#176b87"></i>Pickup</span>':''}<span><i class="legend-dot" style="background:#c83e4d"></i>${isHospitalLeg?"Current ambulance": "Ambulance"}</span><span><i class="legend-dot" style="background:#16845b"></i>Hospital</span></div>
        <div class="card section-gap"><h3>Route guidance</h3>${routeInstructionsMarkup(a)}</div>
      </div>
      <div class="route-side">
        <div class="card"><div class="eyebrow">${safe(etaLabel)}</div><div class="big-eta">${isDone||a.status==="arrived"?"Arrived":a.eta!=null?`${a.eta} min`:"—"}</div><p class="muted small">${a.distance!=null?`${a.distance} km remaining · OSRM road estimate`:"Road estimate unavailable"}</p><div class="info-line"><span>Ambulance unit</span><strong>${safe(a.ambulance?.unit||a.ambulance?.id||"Assigned")}</strong></div><div class="info-line"><span>Crew member</span><strong>${safe(a.ambulance?.crewName||a.ambulance?.name||"Awaiting assignment")}</strong></div><div class="info-line"><span>Crew ID</span><strong>${safe(a.ambulance?.crewId||"Not available")}</strong></div><div class="info-line"><span>Crew role</span><strong>${safe(a.ambulance?.role||"Not available")}</strong></div><div class="info-line"><span>Crew phone</span><strong>${safe(a.ambulance?.phone||"Not available")}</strong></div><div class="info-line"><span>Status</span><strong>${safe(statusLabel(a.status))}</strong></div><div class="info-line"><span>Last map update</span><strong id="lastTrackUpdate">${safe(a.lastLocationUpdate||a.updated)}</strong></div><div id="trackingStateNote" class="notice small" style="margin-top:12px">${"The remaining road route and ETA refresh as the ambulance shares fresh GPS positions."}</div></div>
        <div class="card"><h3>Destination hospital</h3><strong>${safe(a.hospital?.name||"Destination pending")}</strong><p class="muted small" style="margin:6px 0 14px">${safe(a.hospital?.address||"No destination selected")}</p><p class="muted small">${a.hospital?.coords?"Map coordinates available.":"The crew will select a hospital after pickup."}</p><button class="btn secondary full" data-goto="hospital">View / choose hospital</button></div>
        ${contactAlertCardMarkup(a)}
        <div class="card"><h3>Live journey synchronisation</h3><p class="muted small">The ambulance crew controls journey milestones. This page updates automatically as the server receives device GPS positions and crew confirmations.</p><div class="info-line"><span>Location source</span><strong>Crew device GPS</strong></div><div class="info-line"><span>Last shared position</span><strong>${safe(a.lastLocationUpdate||"Waiting")}</strong></div></div>
      </div></div>
      ${journeyTimelineMarkup(a)}
      <div class="notice warn section-gap">Road-route ETAs are estimates and do not include live traffic. Public map and routing services can be rate-limited or temporarily unavailable. ${"Ambulance position is supplied by the crew device GPS."}</div>`;

    if(window.MediRouteMaps){
      const ready=window.MediRouteMaps.renderTrackingMap({pickup:isToPickup?a.location?.coords:null,ambulance:ambulancePoint,ambulanceLabel:isHospitalLeg?"Current ambulance location":"Ambulance · live device location",hospital:a.hospital?.coords,route:trackingRoute});
      if(!ready&&$("trackingMapStatus"))$("trackingMapStatus").textContent="The map library could not load. Reload the page to retry; request and journey details remain available.";
    }else if($("trackingMapStatus"))$("trackingMapStatus").textContent="Map services are unavailable. Request and journey details remain available.";

    if(!routeExists&&!a.routeLoading&&!a.routeError&&activeRouteEndpoints(a)){
      a.routeLoading=true;
      loadActiveRoute().then(()=>{if(document.querySelector("#page-tracking.active"))renderTracking();});
    }
    $("previewContactAlert")?.addEventListener("click",()=>showContactAlertPreview(a));
  }
  function renderHospital(){
    const root=$("hospitalContent"),a=state.active,h=a?.hospital;
    if(!a){root.innerHTML=`<div class="card empty"><div class="empty-icon">✚</div><h2>No active request</h2><p>A destination appears after an ambulance has been assigned and the crew selects a hospital.</p><button class="btn primary" data-goto="emergency">Start a request</button></div>`;return}
    const hasCoordinates=!!h?.coords;
    const destinationCard=`<div class="card">
      <div style="height:145px;background:linear-gradient(135deg,#d9efeb,#eef6f3);border-radius:14px;display:grid;place-items:center;font-size:52px;color:#087f8c;margin-bottom:20px">✚</div>
      <span class="pill ${hasCoordinates?"teal":"amber"}">${hasCoordinates?(a.shared?"Selected by ambulance crew":"Map-listed destination"):"Destination pending"}</span>
      <h2 style="margin-top:12px">${safe(h?.name||"No destination selected")}</h2><p class="muted">${safe(h?.address||"The hospital will appear here after the ambulance crew selects it.")}</p>
      <div class="info-line"><span>Destination source</span><strong>${safe(h?.source|| (a.shared?"Ambulance crew":"OpenStreetMap listing"))}</strong></div>
      <div class="info-line"><span>Coordinates</span><strong>${hasCoordinates?`${Number(h.coords.lat).toFixed(5)}, ${Number(h.coords.lng).toFixed(5)}`:"Not available"}</strong></div>
      ${a.shared?`<div class="info-line"><span>Selected by</span><strong>${safe(a.ambulance?.crewName||"Assigned crew")}</strong></div>`:""}
      <div class="info-line"><span>Admission / capacity</span><strong>Not verified</strong></div>
      <div class="notice warn" style="margin-top:16px">Hospital name and destination are shared from the ambulance crew. This application does not verify hospital capacity, suitability, availability or acceptance.</div>
    </div>`;
    const rightCard=a.shared?`<div class="card"><h2>Hospital destination</h2><p class="muted small">The assigned crew will record patient observations, compare the available hospital records and choose the destination. This page updates automatically when the crew confirms it.</p><div class="info-line"><span>Journey stage</span><strong>${safe(statusLabel(a.status))}</strong></div><button class="btn primary full" data-goto="tracking">View current route</button></div>`:`<div class="card">
      <h2>Find hospitals near pickup</h2><p class="muted small">Searches public OpenStreetMap place listings around the confirmed pickup coordinates. Search runs only when you press the button; there is no autocomplete.</p>
      <button id="searchNearbyHospitals" class="btn primary full" ${a.location?.coords?"":"disabled"}>⌖ Find nearby hospitals</button>
      <div id="hospitalSearchStatus" class="small muted" role="status" style="margin-top:10px">${a.location?.coords?"Ready to search around your pickup point.":"A map-confirmed pickup point is required."}</div>
      <div id="hospitalSearchResults" class="list section-gap"></div>
      <button class="btn outline full" style="margin-top:14px" data-goto="tracking">Back to journey tracking</button>
    </div>`;
    root.innerHTML=`<div class="grid two">${destinationCard}${rightCard}</div>`;
    $("searchNearbyHospitals")?.addEventListener("click",async()=>{
      const button=$("searchNearbyHospitals"),status=$("hospitalSearchStatus"),results=$("hospitalSearchResults");
      if(!a.location?.coords){status.textContent="A map-confirmed pickup point is required.";return}
      if(!window.MediRouteMaps){status.textContent="Map services did not load. Reload the page to retry.";return}
      button.disabled=true;button.textContent="Searching…";status.textContent="Searching OpenStreetMap for nearby hospital listings…";results.innerHTML="";
      try{
        nearbyHospitalResults=await window.MediRouteMaps.searchNearbyHospitals(a.location.coords);
        if(!nearbyHospitalResults.length){status.textContent="No nearby hospital listings were returned. Try adjusting the pickup map pin or retry later.";return}
        status.textContent=`${nearbyHospitalResults.length} nearby map listing${nearbyHospitalResults.length===1?"":"s"}. Select one only to preview a road route.`;
        results.innerHTML=nearbyHospitalResults.map((item,index)=>`<div class="list-item"><div class="list-icon">✚</div><div class="list-copy"><strong>${safe(item.name)}</strong><span>${safe(item.displayName)}</span><span>${item.distanceKm.toFixed(1)} km straight-line from pickup · road distance may differ</span><div class="actions" style="margin-top:8px"><button type="button" class="btn outline" data-hospital-result="${index}">Select hospital</button></div></div></div>`).join("");
      }catch(error){status.textContent=error.message||"Hospital search failed. Try again later.";}
      finally{button.disabled=false;button.textContent="⌖ Find nearby hospitals";}
    });
  }
  document.addEventListener("click",async e=>{
    const button=e.target.closest("[data-hospital-result]");if(!button)return;
    const item=nearbyHospitalResults[Number(button.dataset.hospitalResult)];if(!item||!state.active)return;
    state.active.hospital={id:item.id,name:item.name,address:item.displayName,coords:{lat:item.lat,lng:item.lng},facilities:["OpenStreetMap place listing · not independently verified"],source:"nominatim"};
    state.active.routeData=null;state.active.routeMode=null;state.active.routeError="";
    if(["pickedup","enroute"].includes(state.active.status))await loadActiveRoute();
    state.active.updated=now();
    recordEmergencyContactAlert(state.active,"Hospital destination selected");
    addNotification("Hospital destination selected",`${item.name} was selected as the map destination for route preview. Hospital suitability and capacity are not verified.`,"info","hospital");
    renderHospital();renderDashboard();
    toast("Destination selected","The hospital route can now be previewed in tracking.","success");
  });
  function renderIntake(){
    const root=$("intakeContent"),p=state.profile,a=state.active;
    const contactSummary=getEmergencyContacts(p).filter(c=>c.name&&c.phone).map(c=>`${c.name}${c.relationship?` (${c.relationship})`:""} · ${c.phone}${c.consented?" · opted in":" · not opted in"}`).join("; ");
    const fields=[["Patient name",p.name],["Patient ID",p.id],["Email",p.email],["Mobile number",p.phone],["Blood group",p.blood],["Emergency contacts",contactSummary],["Pickup location",a?.location?.address]];
    const complete=fields.filter(x=>String(x[1]||"").trim()).length;
    root.innerHTML=`<div class="grid two"><div class="card"><div class="split-head"><div><h2>Patient intake summary</h2><p class="muted small">Read-only summary of the patient information recorded for this journey.</p></div><span class="pill amber">Not sent</span></div><div class="notice ${complete===fields.length?"success":"warn"}"> ${complete} of ${fields.length} fields have values. Missing optional information can remain blank.</div><div class="list section-gap">${fields.map(([label,value])=>`<div class="list-item"><div class="list-icon">${value?"✓":"—"}</div><div class="list-copy"><strong>${safe(label)}</strong><span>${value?safe(value):"Not provided"}</span></div><span class="pill ${value?"green":"amber"}">${value?"Available":"Incomplete"}</span></div>`).join("")}</div><button class="btn primary" data-goto="profile">Review my profile</button></div><div><div class="card"><h2>Preparation status</h2><div class="list-item"><div class="list-icon">▣</div><div class="list-copy"><strong>${a?"Intake summary prepared":"Awaiting an emergency request"}</strong><span>${a?"The summary uses the current patient profile and request.":"Create an emergency request to associate pickup information."}</span></div></div><div class="info-line"><span>Destination</span><strong>${safe(a?.hospital?.name||"Not selected")}</strong></div><div class="info-line"><span>Hospital receipt</span><strong>Not sent</strong></div><div class="info-line"><span>Clinical review</span><strong>Not performed</strong></div></div><div class="notice warn section-gap"><b>Important:</b> This is not a real hospital referral. The information is not transmitted to a hospital and this preview is not a clinical record.</div></div></div>`;
  }
  function renderProfile(){
    const p=state.profile,contacts=getEmergencyContacts(p);
    $("profileName").value=p.name;$("profileEmail").value=p.email;
    $("profilePhone").value=p.phone;$("profileBlood").value=p.blood;
    $("profileEmergencyContact").value=contacts[0].phone||p.emergencyContact||"";
    contacts.forEach((c,index)=>{
      const n=index+1;
      $(`profileContact${n}Name`).value=c.name;
      $(`profileContact${n}Relation`).value=c.relationship;
      $(`profileContact${n}Phone`).value=c.phone;
      $(`profileContact${n}Consent`).checked=c.consented;
    });
    $("profileDisplayName").textContent=p.name;$("profileDisplayId").textContent=p.id;$("profileAvatar").textContent=p.name.charAt(0).toUpperCase()||"P";
    const saved=contacts.filter(c=>c.name.trim()&&c.phone.trim()).length;
    const opted=contacts.filter(c=>c.name.trim()&&c.phone.trim()&&c.consented).length;
    const checks=[["Name",p.name],["Email",p.email],["Mobile number",p.phone],["Blood group",p.blood],["Emergency contacts",saved?`${saved} of 2 saved`:""],["Contact alert consent",opted?`${opted} opted in`:""]];
    const count=checks.filter(x=>!!x[1]).length;const percent=Math.round(count/checks.length*100);
    $("profileProgressBar").style.width=percent+"%";$("profileProgressText").textContent=percent+"% complete";
    $("profileMissing").innerHTML=checks.map(([name,val])=>`<div class="list-item"><div class="list-icon">${val?"✓":"—"}</div><div class="list-copy"><strong>${safe(name)}</strong><span>${val?safe(val):"Optional · not provided"}</span></div></div>`).join("");
    $("profileContactStatus").textContent=`${saved} of 2 contacts saved · ${opted} opted in to receive emergency updates. Contacts are only included when they have agreed.`;
    $("profileSuccess").classList.add("hidden");$("profileError").textContent="";
  }
  $("profileForm").addEventListener("submit",async e=>{
    e.preventDefault();
    const name=$("profileName").value.trim(),email=$("profileEmail").value.trim();
    if(name.length<2||!email){$("profileError").textContent="Enter a valid name and email.";return;}
    const contacts=[1,2].map(n=>({name:$(`profileContact${n}Name`).value.trim(),relationship:$(`profileContact${n}Relation`).value.trim(),phone:$(`profileContact${n}Phone`).value.trim(),consented:$(`profileContact${n}Consent`).checked}));
    for(let i=0;i<contacts.length;i++){
      const c=contacts[i],hasAny=!!(c.name||c.relationship||c.phone||c.consented);
      if(hasAny&&(!c.name||!c.phone)){$("profileError").textContent=`Complete the name and mobile number for emergency contact ${i+1}, or clear that contact.`;return;}
      if(c.phone){const digits=c.phone.replace(/\D/g,"");if(digits.length<7||digits.length>15){$("profileError").textContent=`Enter a valid phone number for emergency contact ${i+1} (7–15 digits, including country code when needed).`;return;}}
      if(c.consented&&(!c.name||!c.phone)){$("profileError").textContent=`Add a name and phone number before opting in emergency contact ${i+1}.`;return;}
    }
    const nextProfile={...state.profile,name,email,phone:$("profilePhone").value.trim(),blood:$("profileBlood").value,emergencyContact:contacts[0].phone||contacts[1].phone||"",emergencyContacts:contacts};
    try{
      const saved=await window.MediRouteSync.savePatientProfile(nextProfile);
      state.profile={...state.profile,...saved.profile,emergencyContacts:getEmergencyContacts(saved.profile)};
      addNotification("Patient profile updated","Your profile and two emergency contacts were saved to the shared MediRoute server.","success","profile");
      renderProfile();$("profileSuccess").classList.remove("hidden");renderDashboard();
      toast("Profile saved","Emergency contacts and consent settings were saved to your account.","success");
    }catch(error){$("profileError").textContent=error.message||"Could not save your profile to the shared server.";}
  });
  $("cancelProfile").addEventListener("click",()=>renderProfile());
  function renderHistory(){$("historyContent").innerHTML=historyRows(state.history)}
  function resetJourneyComposer(){
    state.location=null;state.locationDraft=null;state.locationConfirmed=false;state.wizardStep=1;
    state.details={type:"",description:"",contact:"",blood:"",emergencyContact:""};
    pickupSearchResults=[];nearbyHospitalResults=[];
    ["locationSearchQuery","manualAddress","locationLabel","emergencyType","incidentDescription"].forEach(id=>{if($(id))$(id).value="";});
    ["pickupSearchResults","pickupSearchStatus"].forEach(id=>{if($(id))$(id).innerHTML="";});
    if($("locationFeedback"))$("locationFeedback").textContent="";
    if($("locationConfirmed"))$("locationConfirmed").classList.add("hidden");
    if($("nextLocation"))$("nextLocation").disabled=true;
    if($("emergencyContact"))$("emergencyContact").value=state.profile.phone||getEmergencyContacts().find(c=>c.phone)?.phone||"";
    if($("emergencyBlood"))$("emergencyBlood").value=state.profile.blood||"";
    if($("confirmRequest"))$("confirmRequest").checked=false;
  }
  function finalizeJourneyAndReturnHome(requestId){
    if(!state.active||state.active.id!==requestId||!(state.active.status==="arrived"||state.active.status==="completed"))return;
    state.active=null;resetJourneyComposer();
    updateHeaderMode();go("dashboard");
    toast("Journey completed","Your account is still signed in. The next request is ready from Home, and this journey is saved in History.","success");
    if(journeyCompletionTimer){clearTimeout(journeyCompletionTimer);journeyCompletionTimer=null;}
  }
  function prefillEmergencyProfile(force=false){
    // Use details already saved in the profile; never overwrite something the user has typed.
    if(force || !$('emergencyContact').value) $('emergencyContact').value=state.profile.phone||state.profile.emergencyContact||"";
    if(force || !$('emergencyBlood').value) $('emergencyBlood').value=state.profile.blood||"";
  }
  function startNewEmergency(){
    if(state.active&&!['completed','cancelled'].includes(state.active.status)){toast("Active request exists","Complete or cancel the current request before starting another.","error");return}
    state.active=null;state.location=null;state.locationDraft=null;state.locationConfirmed=false;
    state.details={type:"",description:"",contact:"",blood:"",emergencyContact:state.profile.emergencyContact||""};state.wizardStep=1;
    pickupSearchResults=[];nearbyHospitalResults=[];
    $("locationSearchQuery").value="";$("pickupSearchResults").innerHTML="";$("pickupSearchStatus").textContent="";
    $("manualAddress").value="";$("locationLabel").value="";$("emergencyType").value="";$("incidentDescription").value="";$("emergencyContact").value=state.profile.phone||state.profile.emergencyContact||"";$("emergencyBlood").value=state.profile.blood||"";
    $("confirmRequest").checked=false;
    go("emergency");
  }
  $("markAllRead").addEventListener("click",()=>{state.notifications.forEach(n=>n.read=true);renderNotificationBits();toast("Notifications updated","All notifications marked as read.","success")});
  function updateHeaderMode(){ $("logoutBtn").classList.toggle("hidden",!state.loggedIn); }
  document.addEventListener("click",e=>{
    const nav=e.target.closest("[data-page]");if(nav){go(nav.dataset.page);return}
    const goto=e.target.closest("[data-goto]");if(goto){go(goto.dataset.goto);return}
    const notif=e.target.closest("[data-notif-page]");if(notif){const n=state.notifications.find(x=>x.id===Number(notif.dataset.notifId));if(n)n.read=true;go(notif.dataset.notifPage);return}
    const read=e.target.closest("[data-read-id]");if(read){const n=state.notifications.find(x=>x.id===Number(read.dataset.readId));if(n)n.read=true;renderNotificationBits();return}
  });
  $("loginFormEl").addEventListener("submit",async e=>{e.preventDefault();const email=$("loginEmail").value.trim(),pass=$("loginPassword").value;if(!email||pass.length<8){$("loginError").textContent="Enter an email or patient ID and a password of at least 8 characters.";return}
    const btn=e.submitter;$("loginError").textContent="";btn.disabled=true;btn.textContent="Signing in…";
    try{const result=await window.MediRouteSync.patientLogin(email,pass);state.loggedIn=true;state.profile={...state.profile,...result.profile,emergencyContacts:getEmergencyContacts(result.profile)};showApp();startSharedPolling();toast("Welcome back","You are signed in to your shared patient account.","success");}
    catch(error){$("loginError").textContent=error.message||"Could not sign in to the shared MediRoute server.";}
    finally{btn.disabled=false;btn.innerHTML='Sign in to Medi Route <span>→</span>';}
  });
  $("showPass").addEventListener("change",e=>$("loginPassword").type=e.target.checked?"text":"password");
  $("toRegister").addEventListener("click",e=>{e.preventDefault();$("loginForm").classList.add("hidden");$("registerForm").classList.remove("hidden")});
  $("toLogin").addEventListener("click",e=>{e.preventDefault();$("registerForm").classList.add("hidden");$("loginForm").classList.remove("hidden")});
  $("registerFormEl").addEventListener("submit",async e=>{e.preventDefault();const name=$("regName").value.trim(),email=$("regEmail").value.trim(),p=$("regPassword").value,c=$("regConfirm").value;if(name.length<2||!email){$("registerError").textContent="Enter a name and valid email.";return}if(p.length<8){$("registerError").textContent="Password must be at least 8 characters.";return}if(p!==c){$("registerError").textContent="Passwords do not match.";return}
    const btn=e.submitter;btn.disabled=true;
    try{const result=await window.MediRouteSync.patientRegister({name,email,phone:$("regPhone").value.trim(),blood:$("regBlood").value},p);state.profile={...state.profile,...result.profile,emergencyContacts:getEmergencyContacts(result.profile)};state.loggedIn=true;addNotification("Patient account created","Your patient account was created on the shared MediRoute server.","success","profile");showApp();startSharedPolling();toast("Account created","Your account is now available to sign in from either laptop.","success");}
    catch(error){$("registerError").textContent=error.message||"Could not create account.";}
    finally{btn.disabled=false;}
  });
  function showApp(){$("authView").classList.add("hidden");$("authView").style.display="none";$("appView").classList.remove("hidden");$("appView").style.display="block";updateHeaderMode();go("dashboard")}
  async function signOut(){if(sharedPollingStop)sharedPollingStop();sharedPollingStop=null;try{await window.MediRouteSync.logout();}catch{}$("appView").classList.add("hidden");$("appView").style.display="none";$("authView").classList.remove("hidden");$("authView").style.display="grid";$("loginForm").classList.remove("hidden");$("registerForm").classList.add("hidden");$("loginPassword").value="";$("loginError").textContent="";state.loggedIn=false;updateHeaderMode()}
  $("logoutBtn").addEventListener("click",signOut);
  // Session state is cleared on sign-out; account and journey records remain on the server.
  function renderInitial(){renderNotificationBits()}
  // Restore an authenticated session after refresh and keep both portals synchronised.
  if(window.MediRouteSync?.authenticated){
    window.MediRouteSync.snapshot().then(snapshot=>{
      if(snapshot.profile){state.loggedIn=snapshot.role==="patient";state.profile={...state.profile,...snapshot.profile,emergencyContacts:getEmergencyContacts(snapshot.profile)};showApp();syncPatientSnapshot(snapshot);startSharedPolling();}
    }).catch(()=>{});
  }
  updateHeaderMode();
  renderInitial();
})();
