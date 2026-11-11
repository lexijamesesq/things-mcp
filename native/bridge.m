#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <libproc.h>
#import <sys/proc_info.h>
#include <unistd.h>
// Documented Apple Events for task operations; explicit background-first startup only.
// Never launch from an event retry or resolve a replacement process after dispatch.
static NSAppleEventDescriptor *target;
static NSRunningApplication *application;
static struct proc_bsdinfo identity;
static OSStatus nativeError=0;
static BOOL dispatched=NO;
static BOOL launchAttempted=NO;
static void fail(NSString *code) { @throw [NSException exceptionWithName:code reason:code userInfo:nil]; }
static NSAppleEventDescriptor *spec(DescType cls, DescType form, NSAppleEventDescriptor *key, NSAppleEventDescriptor *container) {
 NSAppleEventDescriptor *record=[NSAppleEventDescriptor recordDescriptor];
 [record setDescriptor:[NSAppleEventDescriptor descriptorWithTypeCode:cls] forKeyword:keyAEDesiredClass];
 [record setDescriptor:container?:[NSAppleEventDescriptor nullDescriptor] forKeyword:keyAEContainer];
 [record setDescriptor:[NSAppleEventDescriptor descriptorWithEnumCode:form] forKeyword:keyAEKeyForm];
 [record setDescriptor:key forKeyword:keyAEKeyData];
 return [record coerceToDescriptorType:typeObjectSpecifier];
}
static NSAppleEventDescriptor *all(void) {DescType code=kAEAll;return [NSAppleEventDescriptor descriptorWithDescriptorType:typeAbsoluteOrdinal bytes:&code length:sizeof(code)];}
static NSAppleEventDescriptor *property(DescType code, NSAppleEventDescriptor *container) { return spec(typeProperty,formPropertyID,[NSAppleEventDescriptor descriptorWithTypeCode:code],container); }
static NSAppleEventDescriptor *sendEvent(AEEventID eid, NSDictionary<NSNumber *,NSAppleEventDescriptor *> *parameters) {
 struct proc_bsdinfo now={0}; pid_t pid=application.processIdentifier;
 if(application.terminated||proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&now,sizeof(now))!=sizeof(now)||identity.pbi_start_tvsec!=now.pbi_start_tvsec||identity.pbi_start_tvusec!=now.pbi_start_tvusec) fail(@"unavailable");
 NSAppleEventDescriptor *event=[NSAppleEventDescriptor appleEventWithEventClass:kAECoreSuite eventID:eid targetDescriptor:target returnID:kAutoGenerateReturnID transactionID:kAnyTransactionID];
 for(NSNumber *key in parameters) [event setParamDescriptor:parameters[key] forKeyword:key.unsignedIntValue];
 NSError *error=nil; dispatched=YES;
 NSAppleEventDescriptor *reply=[event sendEventWithOptions:(kAEWaitReply|kAENeverInteract|kAEDontReconnect|kAEDoNotPromptForUserConsent) timeout:5 error:&error];
 if(!reply||[reply paramDescriptorForKeyword:keyErrorNumber].int32Value){nativeError=error?(OSStatus)error.code:[reply paramDescriptorForKeyword:keyErrorNumber].int32Value;fail(@"native_error");}
 return [reply paramDescriptorForKeyword:keyDirectObject];
}
static NSAppleEventDescriptor *get(NSAppleEventDescriptor *obj) {return sendEvent(kAEGetData,@{@(keyDirectObject):obj});}
static NSString *str(NSDictionary *request, NSString *key, NSUInteger max) {
 id value=request[key]; if(![value isKindOfClass:NSString.class]||[value length]==0||[value length]>max) fail(@"invalid_argument"); return value;
}
static void exact(NSDictionary *r,NSArray *keys) {for(NSString *key in r) if(![keys containsObject:key]) fail(@"invalid_argument");}
int main(int argc, const char **argv) { @autoreleasepool { @try {
 // Installation only: the normal service always invokes this helper without arguments.
 BOOL authorizeSetup=argc==2 && strcmp(argv[1],"--authorize-setup")==0;
 if(argc!=1 && !authorizeSetup)fail(@"invalid_argument");
 NSMutableData *data=[NSMutableData data]; uint8_t bytes[4096]; ssize_t n;
 while((n=read(STDIN_FILENO,bytes,sizeof(bytes)))>0){[data appendBytes:bytes length:n];if(data.length>262144)fail(@"invalid_argument");}
 if(n<0)fail(@"invalid_argument");
 NSDictionary *r=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
 if(![r isKindOfClass:NSDictionary.class])fail(@"invalid_argument");
 NSString *op=str(r,@"operation",32);
 if(authorizeSetup && ![op isEqual:@"status"])fail(@"invalid_argument");
 NSArray *allowed=@[@"ensure_running",@"list_catalog",@"list_ids",@"status",@"version",@"get",@"create",@"set_title",@"set_notes",@"set_status"];
 if(![allowed containsObject:op])fail(@"unsupported_operation");
 if([op isEqual:@"create"]){exact(r,@[@"operation",@"title",@"notes"]);str(r,@"title",1000);if(r[@"notes"]&&(![r[@"notes"] isKindOfClass:NSString.class]||[r[@"notes"] length]>100000))fail(@"invalid_argument");}
 else if([op isEqual:@"list_ids"]){exact(r,@[@"operation",@"scope"]);if(![r[@"scope"] isEqual:@"inbox"])fail(@"unsupported_scope");}
 else if([op isEqual:@"get"]){exact(r,@[@"operation",@"id"]);str(r,@"id",256);}
 else if([op hasPrefix:@"set_"]){exact(r,@[@"operation",@"id",@"value"]);str(r,@"id",256);if([op isEqual:@"set_notes"]){if(![r[@"value"] isKindOfClass:NSString.class]||[r[@"value"] length]>100000)fail(@"invalid_argument");}else str(r,@"value",1000);if([op isEqual:@"set_status"]&&![@[@"open",@"completed"] containsObject:r[@"value"]])fail(@"invalid_argument");}
 else exact(r,@[@"operation"]);
 NSDictionary *session=CFBridgingRelease(CGSessionCopyCurrentDictionary());
 if(![session[(NSString *)kCGSessionOnConsoleKey] boolValue]||[session[(NSString *)kCGSessionUserIDKey] unsignedIntValue]!=getuid()||[session[@"CGSSessionScreenIsLocked"] boolValue])fail(@"owner_session_unavailable");
 NSArray *apps=[NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.culturedcode.ThingsMac"];
 if(apps.count==0 && [op isEqual:@"ensure_running"]) {
  NSURL *url=[NSURL fileURLWithPath:@"/Applications/Things3.app" isDirectory:YES];
  NSBundle *bundle=[NSBundle bundleWithURL:url];
  if(![bundle.bundleIdentifier isEqual:@"com.culturedcode.ThingsMac"])fail(@"installation_unavailable");
  NSWorkspaceOpenConfiguration *config=[NSWorkspaceOpenConfiguration configuration];
  config.activates=NO;config.hides=YES;config.hidesOthers=NO;
  config.promptsUserIfNeeded=NO;config.addsToRecentItems=NO;
  config.createsNewApplicationInstance=NO;config.allowsRunningApplicationSubstitution=NO;
  dispatch_semaphore_t completed=dispatch_semaphore_create(0);
  __block NSRunningApplication *opened=nil;
  launchAttempted=YES;
  [NSWorkspace.sharedWorkspace openApplicationAtURL:url configuration:config completionHandler:^(NSRunningApplication *app, NSError *error) {
   if(!error)opened=app;
   dispatch_semaphore_signal(completed);
  }];
  if(dispatch_semaphore_wait(completed,dispatch_time(DISPATCH_TIME_NOW,8*NSEC_PER_SEC))!=0)fail(@"launch_timeout");
  if(!opened || opened.terminated)fail(@"launch_failed");
  application=opened;
 } else {
  if(apps.count!=1)fail(@"unavailable");
  application=apps.firstObject;
 }
 pid_t pid=application.processIdentifier;
 if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&identity,sizeof(identity))!=sizeof(identity)||identity.pbi_uid!=getuid())fail(@"unavailable");
 target=[NSAppleEventDescriptor descriptorWithDescriptorType:typeKernelProcessID bytes:&pid length:sizeof(pid)];
 OSStatus permission=AEDeterminePermissionToAutomateTarget(target.aeDesc,kAECoreSuite,kAEGetData,authorizeSetup);
 if(permission!=noErr)fail(@"permission_required");
 id result=@{@"pid":@(pid),@"permission":@"authorized",@"launchAttempted":@(launchAttempted)};
 if([op isEqual:@"version"])result=@{@"version":get(property('vers',nil)).stringValue?:@""};
 NSAppleEventDescriptor *item=r[@"id"]?spec('tstk',formUniqueID,[NSAppleEventDescriptor descriptorWithString:r[@"id"]],nil):nil;
 if([op isEqual:@"list_catalog"]){
  NSAppleEventDescriptor *lists=spec('tsls',formAbsolutePosition,all(),nil);
  NSAppleEventDescriptor *ids=get(property('ID  ',lists));
  NSMutableArray *values=[NSMutableArray array];
  for(NSInteger i=1;i<=ids.numberOfItems;i++){NSString *value=[ids descriptorAtIndex:i].stringValue;if(value)[values addObject:value];}
  result=@{@"ids":values};
 }
 if([op isEqual:@"list_ids"]){
  NSAppleEventDescriptor *list=spec('tsls',formUniqueID,[NSAppleEventDescriptor descriptorWithString:@"TMInboxListSource"],nil);
  NSAppleEventDescriptor *todos=spec('tstk',formAbsolutePosition,all(),list);
  NSAppleEventDescriptor *ids=get(property('ID  ',todos));
  if(ids.descriptorType!=typeAEList || ids.numberOfItems>10000)fail(@"snapshot_limit");
  NSMutableArray *values=[NSMutableArray array];
  for(NSInteger i=1;i<=ids.numberOfItems;i++){NSString *value=[ids descriptorAtIndex:i].stringValue;if(!value||value.length>256)fail(@"invalid_native_output");[values addObject:value];}
  result=@{@"ids":values};
 }
 if([op isEqual:@"get"]){
  NSString *ident=get(property('ID  ',item)).stringValue;NSString *title=get(property('pnam',item)).stringValue;NSString *notes=get(property('note',item)).stringValue;DescType status=get(property('tdst',item)).enumCodeValue;
  if(!ident||!title||!notes)fail(@"invalid_native_output");
  result=@{@"id":ident,@"title":title,@"notes":notes,@"status":status=='tdio'?@"open":status=='tdcm'?@"completed":status=='tdcl'?@"canceled":@"unknown",@"recurrence":@"unknown"};
 }
 if([op isEqual:@"create"]){
  NSAppleEventDescriptor *props=[NSAppleEventDescriptor recordDescriptor];[props setDescriptor:[NSAppleEventDescriptor descriptorWithString:r[@"title"]] forKeyword:'pnam'];
  if(r[@"notes"])[props setDescriptor:[NSAppleEventDescriptor descriptorWithString:r[@"notes"]] forKeyword:'note'];
  NSAppleEventDescriptor *created=sendEvent(kAECreateElement,@{@(keyAEObjectClass):[NSAppleEventDescriptor descriptorWithTypeCode:'tstk'],@(keyAEPropData):props});
  NSString *ident=get(property('ID  ',created)).stringValue;if(!ident)fail(@"invalid_native_output");result=@{@"id":ident};
 }
 if([op hasPrefix:@"set_"]){
  DescType code=[op isEqual:@"set_title"]?'pnam':[op isEqual:@"set_notes"]?'note':'tdst';
  NSAppleEventDescriptor *value=code=='tdst'?[NSAppleEventDescriptor descriptorWithEnumCode:[r[@"value"] isEqual:@"open"]?'tdio':'tdcm']:[NSAppleEventDescriptor descriptorWithString:r[@"value"]];
  sendEvent(kAESetData,@{@(keyDirectObject):property(code,item),@(keyAEData):value});result=@{@"id":r[@"id"]};
 }
 NSData *output=[NSJSONSerialization dataWithJSONObject:@{@"ok":@YES,@"dispatched":@(dispatched),@"result":result} options:0 error:nil];if(output.length>1048576)fail(@"output_limit");fwrite(output.bytes,1,output.length,stdout);puts("");
 } @catch(NSException *e){NSData *output=[NSJSONSerialization dataWithJSONObject:@{@"ok":@NO,@"launchAttempted":@(launchAttempted),@"dispatched":@(dispatched),@"error":e.name,@"nativeCode":@(nativeError)} options:0 error:nil];fwrite(output.bytes,1,output.length,stdout);puts("");return 1;}
 } return 0; }
