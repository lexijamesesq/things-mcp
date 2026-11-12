// Test-only translation unit: execute production control flow with OS boundaries replaced.
// Never link this file into the installed helper. No real Automation or app launch occurs.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <libproc.h>
#import <sys/proc_info.h>
#import <objc/runtime.h>
#include <unistd.h>

static NSString *scenario;
static int sessionChecks, processChecks, permissionChecks, appLookups, eventCalls, openCalls;
static BOOL askedForPermission, eventTargetsSelf;
static NSAppleEventSendOptions observedOptions;
static NSTimeInterval observedTimeout;
static NSMutableArray *events;

static CFDictionaryRef fixtureSession(void) {
 sessionChecks++;
 BOOL locked=[scenario isEqual:@"locked"] || ([scenario isEqual:@"locked_after_capture"] && sessionChecks>1);
 return CFBridgingRetain(@{(NSString *)kCGSessionOnConsoleKey:@(![scenario isEqual:@"off_console"]),
  (NSString *)kCGSessionUserIDKey:@([scenario isEqual:@"wrong_owner"]?getuid()+1:getuid()),
  @"CGSSessionScreenIsLocked":@(locked)});
}
static int fixtureProcess(int pid, int flavor, uint64_t arg, void *buffer, int size) {
 (void)flavor;(void)arg;
 processChecks++;
 if(pid!=getpid() || size!=(int)sizeof(struct proc_bsdinfo))return 0;
 if([scenario isEqual:@"exited_after_capture"] && processChecks>1)return 0;
 struct proc_bsdinfo info={0};info.pbi_uid=getuid();info.pbi_start_tvsec=1;info.pbi_start_tvusec=2;
 if([scenario isEqual:@"replaced_after_capture"] && processChecks>1)info.pbi_start_tvusec=3;
 memcpy(buffer,&info,sizeof(info));return sizeof(info);
}
static OSStatus fixturePermission(const AEAddressDesc *address, AEEventClass cls, AEEventID event, Boolean ask) {
 (void)address;(void)cls;(void)event;
 permissionChecks++;askedForPermission=askedForPermission||ask;
 return [scenario isEqual:@"permission_denied"]?errAEEventNotPermitted:noErr;
}
@interface BoundaryHooks : NSObject
+ (NSArray *)fixtureApps:(NSString *)bundleIdentifier;
- (pid_t)fixturePid;
- (BOOL)fixtureTerminated;
- (NSAppleEventDescriptor *)fixtureSend:(NSAppleEventSendOptions)options timeout:(NSTimeInterval)timeout error:(NSError **)error;
- (void)fixtureOpen:(NSURL *)url configuration:(NSWorkspaceOpenConfiguration *)configuration completionHandler:(void (^)(NSRunningApplication *, NSError *))completion;
@end
@implementation BoundaryHooks
- (pid_t)fixturePid { return getpid(); }
- (BOOL)fixtureTerminated { return NO; }
+ (NSArray *)fixtureApps:(NSString *)bundleIdentifier {
 (void)bundleIdentifier;appLookups++;
 return @[NSRunningApplication.currentApplication];
}
- (NSAppleEventDescriptor *)fixtureSend:(NSAppleEventSendOptions)options timeout:(NSTimeInterval)timeout error:(NSError **)error {
 eventCalls++;observedOptions=options;observedTimeout=timeout;
 NSAppleEventDescriptor *address=[(NSAppleEventDescriptor *)self attributeDescriptorForKeyword:keyAddressAttr];
 pid_t pid=0;NSData *data=address.data;
 if(address.descriptorType==typeKernelProcessID && data.length==sizeof(pid))memcpy(&pid,data.bytes,sizeof(pid));
 eventTargetsSelf=pid==getpid();
 NSAppleEventDescriptor *event=(NSAppleEventDescriptor *)self;
 NSAppleEventDescriptor *direct=[event paramDescriptorForKeyword:keyDirectObject];
 NSAppleEventDescriptor *scheduled=[event paramDescriptorForKeyword:'sdat'];
 [events addObject:@{@"class":@(event.eventClass),@"id":@(event.eventID),
  @"dateType":@(scheduled.descriptorType),@"dateSeconds":@(scheduled.dateValue.timeIntervalSince1970),
  @"taskId":[direct descriptorForKeyword:keyAEKeyData].stringValue?:@"",
  @"property":@([direct descriptorForKeyword:keyAEKeyData].descriptorType==typeType?[direct descriptorForKeyword:keyAEKeyData].typeCodeValue:0)}];
 if([scenario hasPrefix:@"schedule_success"] || [scenario hasPrefix:@"read_"]) {
  NSAppleEventDescriptor *value=[NSAppleEventDescriptor nullDescriptor];
  if([scenario hasPrefix:@"read_"]) {
   DescType propertyCode=[direct descriptorForKeyword:keyAEKeyData].typeCodeValue;
   switch(propertyCode) {
    case 'ID  ':value=[NSAppleEventDescriptor descriptorWithString:@"synthetic-fixture"];break;
    case 'pnam':value=[NSAppleEventDescriptor descriptorWithString:@"synthetic-title"];break;
    case 'note':value=[NSAppleEventDescriptor descriptorWithString:@"synthetic-notes"];break;
    case 'tdst':value=[NSAppleEventDescriptor descriptorWithEnumCode:'tdio'];break;
    case 'actd':case 'dued':
     if([scenario isEqual:@"read_missing"])value=propertyCode=='actd'?[NSAppleEventDescriptor descriptorWithTypeCode:'msng']:[NSAppleEventDescriptor nullDescriptor];
     else if([scenario isEqual:@"read_invalid"])value=[NSAppleEventDescriptor descriptorWithString:@"not a date"];
     else value=[NSAppleEventDescriptor descriptorWithDate:[NSDate dateWithTimeIntervalSince1970:propertyCode=='actd'?1794448800:1794535200]];
     break;
    default:@throw [NSException exceptionWithName:@"unexpected_property" reason:nil userInfo:nil];
   }
  }
  NSAppleEventDescriptor *reply=[NSAppleEventDescriptor recordDescriptor];
  [reply setParamDescriptor:value forKeyword:keyDirectObject];return reply;
 }
 if(error)*error=[NSError errorWithDomain:NSOSStatusErrorDomain code:errAETimeout userInfo:nil];
 return nil; // Simulate an ambiguous native failure; never invoke the original method.
}
- (void)fixtureOpen:(NSURL *)url configuration:(NSWorkspaceOpenConfiguration *)configuration completionHandler:(void (^)(NSRunningApplication *, NSError *))completion {
 (void)url;(void)configuration;(void)completion;openCalls++;
 @throw [NSException exceptionWithName:@"test_forbidden_launch" reason:nil userInfo:nil];
}
@end

#define CGSessionCopyCurrentDictionary fixtureSession
#define proc_pidinfo fixtureProcess
#define AEDeterminePermissionToAutomateTarget fixturePermission
#define main bridge_under_test_main
#include "../../native/bridge.m"
#undef main
#undef CGSessionCopyCurrentDictionary
#undef proc_pidinfo
#undef AEDeterminePermissionToAutomateTarget

static void replaceMethod(Method original, Method replacement) {
 if(!original||!replacement)_exit(78); // Fail closed before any production code runs.
 method_exchangeImplementations(original,replacement);
}
int main(int argc,const char **argv) { @autoreleasepool {
 if(argc!=2)return 64;
 scenario=[NSString stringWithUTF8String:argv[1]];events=[NSMutableArray array];
 Class currentAppClass=object_getClass(NSRunningApplication.currentApplication);
 replaceMethod(class_getInstanceMethod(currentAppClass,@selector(processIdentifier)),class_getInstanceMethod(BoundaryHooks.class,@selector(fixturePid)));
 replaceMethod(class_getInstanceMethod(currentAppClass,@selector(isTerminated)),class_getInstanceMethod(BoundaryHooks.class,@selector(fixtureTerminated)));
 replaceMethod(class_getClassMethod(NSRunningApplication.class,@selector(runningApplicationsWithBundleIdentifier:)),class_getClassMethod(BoundaryHooks.class,@selector(fixtureApps:)));
 replaceMethod(class_getInstanceMethod(NSAppleEventDescriptor.class,@selector(sendEventWithOptions:timeout:error:)),class_getInstanceMethod(BoundaryHooks.class,@selector(fixtureSend:timeout:error:)));
 replaceMethod(class_getInstanceMethod(NSWorkspace.class,@selector(openApplicationAtURL:configuration:completionHandler:)),class_getInstanceMethod(BoundaryHooks.class,@selector(fixtureOpen:configuration:completionHandler:)));
 int result=bridge_under_test_main(1,argv);
 NSData *json=[NSJSONSerialization dataWithJSONObject:@{
  @"events":events,@"sessionChecks":@(sessionChecks),@"processChecks":@(processChecks),@"permissionChecks":@(permissionChecks),
  @"appLookups":@(appLookups),@"eventCalls":@(eventCalls),@"openCalls":@(openCalls),
  @"askedForPermission":@(askedForPermission),@"eventTargetsSelf":@(eventTargetsSelf),
  @"neverInteract":@((BOOL)((observedOptions&kAENeverInteract)==kAENeverInteract)),
  @"dontReconnect":@((BOOL)((observedOptions&kAEDontReconnect)!=0)),
  @"doNotPrompt":@((BOOL)((observedOptions&kAEDoNotPromptForUserConsent)!=0)),@"timeout":@(observedTimeout)
 } options:0 error:nil];
 fprintf(stderr,"BOUNDARY:%s\n",[[[NSString alloc]initWithData:json encoding:NSUTF8StringEncoding] UTF8String]);
 return result;
}}
